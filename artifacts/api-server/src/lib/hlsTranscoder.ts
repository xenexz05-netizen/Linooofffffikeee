import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { streamFileByMessage } from "./gramjsClient.js";
import { logger } from "./logger.js";

const HLS_TMP_ROOT = path.join(os.tmpdir(), "f2l-hls");
fs.mkdirSync(HLS_TMP_ROOT, { recursive: true });

// ── Ultra-smooth HLS tuning ───────────────────────────────────────────────
// 1s segments: player only needs to buffer 1-2s before starting — instant play
// pre-buffer 4 segments = 4s ready before first byte sent to player
// hls_list_size=0: keep ALL segments so seeking works across entire video
// MAX_CONCURRENT=3: 3 simultaneous ffmpeg sessions without OOM
// ─────────────────────────────────────────────────────────────────────────
const SESSION_TTL_MS     = 10 * 60 * 1000; // 10 min idle eviction
const MAX_CONCURRENT     = 2;
const STARTUP_TIMEOUT_MS = 90_000;          // 90s max to first segment
const SEGMENT_WAIT_MS    = 15_000;          // 15s max per segment

const HLS_SEGMENT_TIME    = 4;   // 4s segments (VOD best practice)
const HLS_TARGET_DURATION = 8;
const HLS_LIST_SIZE       = 0;   // keep ALL segments — full seek support
const HLS_PREBUFFER_SEGS  = 3;   // wait for 3 segments before serving playlist

interface HlsSession {
  id: string;
  dir: string;
  playlistPath: string;
  ffmpeg: ChildProcess | null;
  ready: Promise<void>;
  lastAccess: number;
  done: boolean;
  failed: boolean;
}

const sessions = new Map<string, HlsSession>();

export function getOrCreateSession(videoId: string, chatId: number, messageId: number): HlsSession {
  const existing = sessions.get(videoId);
  if (existing && !existing.failed) {
    existing.lastAccess = Date.now();
    return existing;
  }
  if (existing?.failed) {
    sessions.delete(videoId);
    try { fs.rmSync(existing.dir, { recursive: true, force: true }); } catch {}
  }

  // Free tier: kill the oldest session to make room
  if (sessions.size >= MAX_CONCURRENT) {
    const oldest = [...sessions.entries()]
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0];
    if (oldest) {
      const [oid, os_] = oldest;
      try { os_.ffmpeg?.kill("SIGKILL"); } catch {}
      try { fs.rmSync(os_.dir, { recursive: true, force: true }); } catch {}
      sessions.delete(oid);
      logger.info({ oid }, "HLS: evicted session (free tier limit)");
    }
  }

  const s = createSession(videoId, chatId, messageId);
  sessions.set(videoId, s);
  return s;
}

function createSession(videoId: string, chatId: number, messageId: number, encode = false): HlsSession {
  const dir          = path.join(HLS_TMP_ROOT, videoId);
  const playlistPath = path.join(dir, "index.m3u8");
  fs.mkdirSync(dir, { recursive: true });

  // ffmpeg args — copy path (H.264/H.265 passthrough, zero CPU):
  // - probesize 2 MB + analyzeduration 500ms: fastest possible startup
  // - thread_queue_size 1024: large input queue prevents ffmpeg blocking on read
  // - -threads 2: 2 threads for muxing (safe, muxer is I/O bound not CPU)
  // - -b:a 128k: slightly higher audio quality for smooth playback
  const copyArgs = [
    "-y",
    "-loglevel",          "error",
    "-fflags",            "+genpts+discardcorrupt+fastseek",
    "-probesize",         "2000000",       // 2 MB probe — fastest startup
    "-analyzeduration",   "500000",        // 0.5s analysis — near-instant
    "-thread_queue_size", "1024",          // large queue prevents read stalls
    "-threads",           "2",
    "-i",                 "pipe:0",
    "-c:v",               "copy",          // zero transcode — 0 CPU overhead
    "-c:a",               "aac",
    "-b:a",               "128k",
    "-ac",                "2",
    "-ar",                "44100",
    "-sn",
    "-f",                 "hls",
    "-hls_time",          String(HLS_SEGMENT_TIME),
    "-hls_target_duration", String(HLS_TARGET_DURATION),
    "-hls_list_size",     String(HLS_LIST_SIZE),
    "-hls_flags",         "independent_segments+delete_segments+append_list",
    "-hls_segment_type",  "mpegts",
    "-hls_segment_filename", path.join(dir, "seg-%05d.ts"),
    "-hls_allow_cache",   "1",
    playlistPath,
  ];

  const encodeArgs = [
    "-y",
    "-loglevel",          "error",
    "-fflags",            "+genpts+discardcorrupt+fastseek",
    "-probesize",         "2000000",
    "-analyzeduration",   "500000",
    "-thread_queue_size", "1024",
    "-threads",           "2",
    "-i",                 "pipe:0",
    "-c:v",               "libx264",
    "-preset",            "ultrafast",     // lowest CPU — stream starts in seconds
    "-tune",              "zerolatency",   // no lookahead — instant output
    "-crf",               "26",            // crf 26 = good quality, fast encode
    "-pix_fmt",           "yuv420p",
    "-profile:v",         "high",          // high profile = better compression
    "-level",             "4.1",
    "-maxrate",           "4000k",         // 4 Mbps ceiling — HD quality
    "-bufsize",           "8000k",
    "-g",                 "24",            // keyframe every 1s at 24fps (=seg time)
    "-keyint_min",        "24",
    "-sc_threshold",      "0",
    "-c:a",               "aac",
    "-b:a",               "128k",
    "-ac",                "2",
    "-ar",                "44100",
    "-sn",
    "-f",                 "hls",
    "-hls_time",          String(HLS_SEGMENT_TIME),
    "-hls_target_duration", String(HLS_TARGET_DURATION),
    "-hls_list_size",     String(HLS_LIST_SIZE),
    "-hls_flags",         "independent_segments+delete_segments+append_list",
    "-hls_segment_type",  "mpegts",
    "-hls_segment_filename", path.join(dir, "seg-%05d.ts"),
    "-hls_allow_cache",   "1",
    playlistPath,
  ];

  const ff = spawn("ffmpeg", encode ? encodeArgs : copyArgs);

  const session: HlsSession = {
    id: videoId, dir, playlistPath,
    ffmpeg: ff,
    ready: Promise.resolve(),
    lastAccess: Date.now(),
    done: false, failed: false,
  };

  let needsReencode = false;

  ff.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (!msg) return;
    logger.debug({ videoId }, `ffmpeg: ${msg.slice(0, 200)}`);
    if (msg.includes("codec copy is not supported") || msg.includes("Error while opening encoder")) {
      needsReencode = true;
    }
  });

  ff.on("close", async (code) => {
    logger.info({ videoId, code }, "ffmpeg HLS exited");
    session.done = true;
    if (code !== 0 && code !== null && !encode && needsReencode && !session.failed) {
      // Give stderr handler 500ms to set the flag before checking
      await new Promise(r => setTimeout(r, 500));
      if (needsReencode && !session.failed) {
        logger.info({ videoId }, "ffmpeg: restarting with encode (copy failed)");
        sessions.delete(videoId);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        const s2 = createSession(videoId, chatId, messageId, true);
        sessions.set(videoId, s2);
      }
    } else if (code !== 0 && code !== null) {
      session.failed = true;
    }
  });

  ff.on("error", (err) => {
    logger.error({ err, videoId }, "ffmpeg spawn error");
    session.failed = true;
  });

  if (ff.stdin) {
    ff.stdin.on("error", (err) => {
      if ((err as any).code !== "EPIPE" && (err as any).code !== "ERR_STREAM_DESTROYED") {
        logger.error({ err, videoId }, "ffmpeg stdin error");
      }
      session.failed = true;
    });
  }

  ff.on("exit", (code) => {
    if (code !== null && code !== 0 && !session.done && !session.failed) {
      session.failed = true;
    }
  });

  streamFileByMessage(chatId, messageId, async (chunk) => {
    if (!ff.stdin || ff.stdin.destroyed) return false;
    try {
      const ok = ff.stdin.write(chunk);
      if (!ok) {
        await new Promise<void>((resolve) => {
          const onDrain = () => { ff.stdin!.off("close", onClose); resolve(); };
          const onClose = () => { ff.stdin!.off("drain", onDrain); resolve(); };
          ff.stdin!.once("drain", onDrain);
          ff.stdin!.once("close", onClose);
        });
      }
      return !session.failed;
    } catch { return false; }
  })
    .then(() => { try { ff.stdin?.end(); } catch {} })
    .catch((err) => {
      logger.error({ err, videoId }, "gramjs→ffmpeg pipe failed");
      session.failed = true;
      try { ff.kill("SIGKILL"); } catch {}
    });

  // Pre-buffer 4 segments (4s) before serving playlist — eliminates initial stutter
  session.ready = waitForSegments(session, HLS_PREBUFFER_SEGS, STARTUP_TIMEOUT_MS);
  return session;
}

function waitForSegments(session: HlsSession, min: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const tick = setInterval(() => {
      if (session.failed) { clearInterval(tick); reject(new Error("HLS transcoder failed")); return; }

      try {
        const files = fs.readdirSync(session.dir).filter(f => f.endsWith(".ts") && !f.includes("tmp"));
        if (files.length >= min) { clearInterval(tick); resolve(); return; }
      } catch {}

      if (fs.existsSync(session.playlistPath)) {
        try {
          const content = fs.readFileSync(session.playlistPath, "utf-8");
          if ((content.match(/\.ts/g) || []).length >= min) { clearInterval(tick); resolve(); return; }
        } catch {}
      }

      if (session.done && !fs.existsSync(session.playlistPath)) {
        clearInterval(tick); session.failed = true;
        reject(new Error("ffmpeg exited before playlist")); return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(tick);
        if (fs.existsSync(session.playlistPath)) {
          logger.warn({ videoId: session.id }, "HLS timeout — serving partial");
          resolve();
        } else {
          session.failed = true;
          reject(new Error("HLS startup timeout"));
        }
      }
    }, 200);
  });
}

export async function readPlaylist(videoId: string, chatId: number, messageId: number, req?: any): Promise<string> {
  const s = getOrCreateSession(videoId, chatId, messageId);
  if (req) {
    req.on("close", () => { s.lastAccess = Date.now() - SESSION_TTL_MS; });
  }
  await s.ready;
  return fs.readFileSync(s.playlistPath, "utf-8");
}

export async function getSegmentFile(videoId: string, segName: string, req?: any): Promise<string | null> {
  const s = sessions.get(videoId);
  if (!s) return null;
  if (!/^seg-\d+\.ts$/.test(segName)) return null;
  if (req) req.on("close", () => { s.lastAccess = Date.now() - SESSION_TTL_MS; });
  s.lastAccess = Date.now();

  const p = path.join(s.dir, segName);
  const start = Date.now();
  while (!fs.existsSync(p)) {
    if (s.failed) return null;
    // If done, wait a bit more for the file to be fully flushed
    if (s.done && Date.now() - start > 3_000) {
      return fs.existsSync(p) ? p : null;
    }
    if (Date.now() - start > SEGMENT_WAIT_MS) return null;
    await new Promise(r => setTimeout(r, 100));
  }
  return p;
}

// Aggressive GC every 3 min on free tier
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastAccess > SESSION_TTL_MS) {
      try { s.ffmpeg?.kill("SIGKILL"); } catch {}
      try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
      sessions.delete(id);
      logger.info({ id }, "HLS: cleaned stale session");
    }
  }
  // Also nuke /tmp HLS entirely if no active sessions
  if (sessions.size === 0) {
    try {
      const entries = fs.readdirSync(HLS_TMP_ROOT);
      if (entries.length > 0) {
        for (const e of entries) {
          try { fs.rmSync(path.join(HLS_TMP_ROOT, e), { recursive: true, force: true }); } catch {}
        }
        logger.debug("HLS: cleared tmp (no active sessions)");
      }
    } catch {}
  }
}, 3 * 60_000).unref();
