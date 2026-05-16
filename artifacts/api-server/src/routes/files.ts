import { Router } from "express";
import { db } from "@workspace/db";
import { filesTable, broadcastsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import * as fs from "fs";
import rateLimit from "express-rate-limit";
import { streamTelegramFile } from "../lib/telegramStream.js";
import { streamVideoFast } from "../lib/ffmpegStream.js";
import { getProgress } from "../lib/videoCache.js";
import { readPlaylist, getSegmentFile } from "../lib/hlsTranscoder.js";
import { formatFileSize, getFileTypeLabel } from "../lib/fileUtils.js";
import { injectResourceHints, getCriticalCSS } from "../lib/streamOptimizer.js";

const router = Router();

const streamLimiter = rateLimit({
  windowMs: 60 * 1000,    // 1 minute
  max: 30,                // 30 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
});

router.use("/stream", streamLimiter);
router.use("/download", streamLimiter);

function escHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const LINK_TTL_MS = 24 * 60 * 60 * 1000;
function isExpired(createdAt: Date | null | undefined): boolean {
  if (!createdAt) return false;
  return Date.now() - new Date(createdAt).getTime() > LINK_TTL_MS;
}
function expiredResponse(res: import("express").Response): void {
  res.status(410).send(
    `<!doctype html><html><head><meta charset="utf-8"><title>Link expired</title>
     <style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#eaeef5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
     .box{max-width:480px;padding:32px;background:#1a1d24;border-radius:16px}h1{margin:0 0 12px;font-size:1.4rem}
     p{color:#9aa3b2;line-height:1.5}</style></head>
     <body><div class="box"><h1>⌛ Link expired</h1><p>This download link has expired (links are valid for 24 hours).<br>Please send the file to the bot again to get a fresh link.</p></div></body></html>`,
  );
}

router.head("/download/:id", async (req, res) => {
  try {
    const rows = await db.select().from(filesTable).where(eq(filesTable.id, req.params.id!)).limit(1);
    if (rows.length === 0) { res.status(404).send("File not found"); return; }
    const file = rows[0]!;
    if (isExpired(file.createdAt)) { res.status(410).end(); return; }
    await streamTelegramFile(req, res, file.chatId, file.messageId, file.mimeType, file.fileName, file.fileSize, true);
  } catch (err) {
    if (!res.headersSent) res.status(500).end();
  }
});

router.get("/download/:id", async (req, res) => {
  const t0 = Date.now();
  req.log.info({ fileId: req.params.id, route: "/download/:id" }, "Stream started");
  req.on("close", () => req.log.info({ fileId: req.params.id, duration: Date.now() - t0 }, "Stream ended"));
  try {
    const rows = await db.select().from(filesTable).where(eq(filesTable.id, req.params.id!)).limit(1);
    if (rows.length === 0) { res.status(404).send("File not found"); return; }
    const file = rows[0]!;
    if (isExpired(file.createdAt)) { expiredResponse(res); return; }
    await db.update(filesTable).set({ accessCount: (file.accessCount || 0) + 1 }).where(eq(filesTable.id, file.id));
    await streamTelegramFile(req, res, file.chatId, file.messageId, file.mimeType, file.fileName, file.fileSize, true);
  } catch (err) {
    req.log.error({ err }, "Download error");
    if (!res.headersSent) res.status(500).send("Server error");
  }
});

router.head("/stream/:id", async (req, res) => {
  try {
    const rows = await db.select().from(filesTable).where(eq(filesTable.id, req.params.id!)).limit(1);
    if (rows.length === 0) { res.status(404).send("File not found"); return; }
    const file = rows[0]!;
    if (isExpired(file.createdAt)) { res.status(410).end(); return; }
    await streamTelegramFile(req, res, file.chatId, file.messageId, file.mimeType, file.fileName, file.fileSize, false);
  } catch (err) {
    if (!res.headersSent) res.status(500).end();
  }
});

router.get("/stream/:id", async (req, res) => {
  const t0 = Date.now();
  req.log.info({ fileId: req.params.id, route: "/stream/:id" }, "Stream started");
  req.on("close", () => req.log.info({ fileId: req.params.id, duration: Date.now() - t0 }, "Stream ended"));
  try {
    const rows = await db.select().from(filesTable).where(eq(filesTable.id, req.params.id!)).limit(1);
    if (rows.length === 0) { res.status(404).send("File not found"); return; }
    const file = rows[0]!;
    if (isExpired(file.createdAt)) { expiredResponse(res); return; }
    await db.update(filesTable).set({ accessCount: (file.accessCount || 0) + 1 }).where(eq(filesTable.id, file.id));
    await streamTelegramFile(req, res, file.chatId, file.messageId, file.mimeType, file.fileName, file.fileSize, false);
  } catch (err) {
    req.log.error({ err }, "Stream error");
    if (!res.headersSent) res.status(500).send("Server error");
  }
});

router.get("/stream-video/:id", async (req, res) => {
  const t0 = Date.now();
  req.log.info({ fileId: req.params.id, route: "/stream-video/:id" }, "Stream started");
  req.on("close", () => req.log.info({ fileId: req.params.id, duration: Date.now() - t0 }, "Stream ended"));
  try {
    const rows = await db.select().from(filesTable).where(eq(filesTable.id, req.params.id!)).limit(1);
    if (rows.length === 0) { res.status(404).send("File not found"); return; }
    const file = rows[0]!;
    if (isExpired(file.createdAt)) { expiredResponse(res); return; }
    req.on("close", () => req.log.info({ fileId: file.id }, "Client disconnected from video stream"));
    await streamVideoFast(req, res, file.id, file.chatId, file.messageId, file.mimeType, file.fileName, file.fileSize);
  } catch (err) {
    req.log.error({ err }, "Stream-video error");
    if (!res.headersSent) res.status(500).send("Server error");
  }
});

router.get("/hls/:id/index.m3u8", async (req, res) => {
  const onErr = (err: Error) => {
    if ((err as any).code !== "EPIPE" && (err as any).code !== "ERR_STREAM_DESTROYED")
      req.log.error({ err }, "HLS playlist socket error");
  };
  res.on("error", onErr);
  try {
    const rows = await db.select().from(filesTable).where(eq(filesTable.id, req.params.id!)).limit(1);
    if (rows.length === 0) { res.off("error", onErr); res.status(404).send("File not found"); return; }
    const file = rows[0]!;
    if (isExpired(file.createdAt)) { res.off("error", onErr); expiredResponse(res); return; }
    const playlist = await readPlaylist(file.id, file.chatId, file.messageId, req);
    const rewritten = playlist.replace(/^(seg-\d+\.ts)$/gm, (m) => `/api/hls/${file.id}/${m}`);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store");
    res.send(rewritten);
  } catch (err) {
    req.log.error({ err }, "HLS playlist error");
    if (!res.headersSent) res.status(500).send("HLS error");
  } finally {
    res.off("error", onErr);
  }
});

router.get("/hls/:id/:seg", async (req, res) => {
  const onErr = (err: Error) => {
    if ((err as any).code !== "EPIPE" && (err as any).code !== "ERR_STREAM_DESTROYED")
      req.log.error({ err }, "HLS segment socket error");
  };
  res.on("error", onErr);
  try {
    const segPath = await getSegmentFile(req.params.id!, req.params.seg!, req);
    if (!segPath || !fs.existsSync(segPath)) {
      res.off("error", onErr);
      res.status(404).send("Segment not ready");
      return;
    }
    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Cache-Control", "public, max-age=3600, immutable");
    const stream = fs.createReadStream(segPath);
    stream.on("error", (err) => {
      req.log.error({ err }, "HLS segment stream error");
      if (!res.headersSent) res.status(500).send("Segment error");
    });
    stream.pipe(res);
  } catch (err) {
    req.log.error({ err }, "HLS segment error");
    if (!res.headersSent) res.status(500).send("Segment error");
  } finally {
    res.off("error", onErr);
  }
});

router.get("/video-progress/:id", (req, res) => {
  const { progress, status } = getProgress(req.params.id!);
  res.json({ progress, status });
});

router.get("/stream-page/:id", async (req, res) => {
  try {
    const rows = await db.select().from(filesTable).where(eq(filesTable.id, req.params.id!)).limit(1);
    if (rows.length === 0) { res.status(404).send("File not found"); return; }
    const file = rows[0]!;

    const streamUrl      = `/api/stream/${file.id}`;
    const videoStreamUrl = `/api/stream-video/${file.id}`;
    const downloadUrl    = `/api/download/${file.id}`;
    const fileLabel      = file.fileName || "Untitled File";

    try {
      const broadcasts = await db.select().from(broadcastsTable).orderBy(desc(broadcastsTable.createdAt)).limit(20);
      broadcasts.reverse();

      const _baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 8080}`;

      const noticesInitial = JSON.stringify(broadcasts.map(b => {
        const isFileType  = b.fileType === "video" || b.fileType === "animation" || b.fileType === "video_note";
        const isAudioType = b.fileType === "audio" || b.fileType === "voice";
        const isImageType = b.fileType === "photo";
        const canStream   = isFileType || isAudioType ||
          (b.mimeType ? (b.mimeType.startsWith("video/") || b.mimeType.startsWith("audio/")) : false);
        try {
          return {
            id: b.id, type: b.type, content: b.content,
            fileId: b.fileId, fileName: b.fileName, mimeType: b.mimeType, fileType: b.fileType,
            canStream,
            isVideo: isFileType || (b.mimeType ? b.mimeType.startsWith("video/") : false),
            isAudio: isAudioType || (b.mimeType ? b.mimeType.startsWith("audio/") : false),
            isImage: isImageType || (b.mimeType ? b.mimeType.startsWith("image/") : false),
            streamUrl:      b.fileId ? `${_baseUrl}/api/stream-page/${b.fileId}` : null,
            downloadUrl:    b.fileId ? `${_baseUrl}/api/download/${b.fileId}` : null,
            rawStreamUrl:   b.fileId ? `${_baseUrl}/api/stream/${b.fileId}` : null,
            videoStreamUrl: b.fileId ? `${_baseUrl}/api/stream-video/${b.fileId}` : null,
            createdAt: b.createdAt instanceof Date ? b.createdAt.toISOString() : String(b.createdAt),
          };
        } catch { return null; }
      }).filter(Boolean));

      const typeLabel = getFileTypeLabel(file.fileType, file.mimeType);
      const sizeLabel = formatFileSize(file.fileSize);
      const isVideo   = file.mimeType?.startsWith("video/") || file.fileType === "video" || file.fileType === "animation" || file.fileType === "video_note";
      const isAudio   = file.isAudio || file.mimeType?.startsWith("audio/") || file.fileType === "audio" || file.fileType === "voice";
      const isImage   = file.mimeType?.startsWith("image/") || file.fileType === "photo" || file.fileType === "sticker";

      const videoStreamUrl = `/api/stream-video/${file.id}`;
      const audioStreamUrl = `/api/stream/${file.id}`;
      const hlsPlaylistUrl = `/api/hls/${file.id}/index.m3u8`;
      const nativeBrowserFmts = ["video/mp4", "video/webm", "video/ogg"];
      const canPlayNative = nativeBrowserFmts.includes(file.mimeType || "");

      let mediaPlayer = "";

      if (isVideo) {
        mediaPlayer = `
        <div class="media-container" id="player-wrap">
          <video
            id="html5-player"
            controls
            playsinline
            preload="metadata"
            style="width:100%;height:auto;min-height:200px;background:#000;"
            controlsList="nodownload"
          >
            <source src="${videoStreamUrl}" type="${file.mimeType || "video/mp4"}">
            Your browser does not support the video tag.
          </video>
        </div>
        <script>
        (function initVideo() {
          var video = document.getElementById('html5-player');
          if (!video) return;
          
          var hlsUrl = '${hlsPlaylistUrl}';
          var direct = '${videoStreamUrl}';
          var hlsLoaded = false;
          
          // Try HLS.js if available and direct fails
          video.addEventListener('error', function() {
            if (hlsLoaded || !window.Hls) return;
            hlsLoaded = true;
            console.warn('Direct playback failed, switching to HLS');
            if (!window.Hls.isSupported()) {
              console.error('HLS not supported');
              return;
            }
            var hls = new window.Hls({ 
              maxBufferLength: 30,
              maxMaxBufferLength: 60,
              lowLatencyMode: true,
              backBufferLength: 15,
              fragLoadingTimeOut: 20000,
              fragLoadingMaxRetry: 6,
              levelLoadingTimeOut: 10000,
              levelLoadingMaxRetry: 4,
            });
            video.src = '';
            hls.loadSource(hlsUrl);
            hls.attachMedia(video);
            hls.on('hlsManifestParsed', function() {
              video.play().catch(function() {});
            });
            hls.on('hlsError', function(e, data) {
              if (data.type === 'fatalError') {
                hls.destroy();
                console.error('HLS fatal error, fallback failed');
              }
            });
          }, { once: true });
          
          // Load HLS.js if not already loaded
          if (!window.Hls && typeof Hls === 'undefined') {
            var script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js';
            script.async = true;
            document.head.appendChild(script);
          }
        })();
        </script>`;
      } else if (isAudio) {
        const unsupported = ["audio/ac3", "audio/eac3", "audio/x-ac3", "audio/truehd", "audio/dts", "audio/x-dts"];
        const canPlay     = !unsupported.includes(file.mimeType || "");
        mediaPlayer = canPlay
          ? `<div class="media-container audio-container">
               <div class="audio-icon">🎵</div>
               <audio id="player" controls preload="auto" style="width:100%;">
                 <source src="${audioStreamUrl}" type="${file.mimeType || "audio/mpeg"}">
               </audio>
             </div>`
          : `<div class="media-container no-preview">
               <div class="no-preview-icon">🔊</div>
               <p>Audio format (<code>${escHtml(file.mimeType || "unknown")}</code>) cannot play in browser.</p>
               <p>Download and open in VLC.</p>
             </div>`;
      } else if (isImage) {
        mediaPlayer = `
          <div class="media-container image-container">
            <img src="${audioStreamUrl}" alt="${escHtml(fileLabel)}" loading="lazy" />
          </div>`;
      } else {
        mediaPlayer = `
          <div class="media-container no-preview">
            <div class="no-preview-icon">📄</div>
            <p>No preview for this file type.</p>
          </div>`;
      }

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(fileLabel)} — File2Link BOT</title>
  <!-- Netflix/YouTube-level streaming optimization -->
  ${injectResourceHints()}
  ${getCriticalCSS()}
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js" defer><\/script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Manrope:wght@400;500;700;800&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --neon: #00ff6a;
      --neon-2: #b7ff00;
      --glow: rgba(0,255,106,0.35);
      --bg: #030403;
      --border: rgba(0,255,106,0.18);
      --text: #effff3;
      --muted: #9ac8a4;
    }
    body {
      min-height: 100vh;
      color: var(--text);
      font-family: 'Inter', sans-serif;
      background:
        radial-gradient(circle at top, rgba(0,255,106,.2), transparent 34%),
        radial-gradient(circle at bottom right, rgba(183,255,0,.08), transparent 24%),
        linear-gradient(135deg, #010201 0%, #07100a 42%, #020202 100%);
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 0 16px 40px;
    }
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background:
        linear-gradient(120deg, rgba(0,255,106,0.05), transparent 36%),
        repeating-linear-gradient(180deg, transparent 0 4px, rgba(255,255,255,0.015) 4px 8px);
      pointer-events: none;
    }
    header, .card, footer { position: relative; z-index: 1; }
    header {
      width: 100%; max-width: 940px; padding: 24px 0 18px;
      display: flex; justify-content: space-between; align-items: center;
      border-bottom: 1px solid var(--border); margin-bottom: 26px;
    }
    .logo {
      font-family: 'Manrope', sans-serif; font-weight: 800; font-size: 1.2rem;
      letter-spacing: 1.6px; color: #fff; text-decoration: none;
      text-shadow: 0 0 18px var(--glow);
    }
    .logo span { color: var(--neon); }
    .card {
      width: 100%; max-width: 940px; padding: 30px;
      background: linear-gradient(180deg, rgba(8,16,10,.95), rgba(3,5,4,.92));
      border: 1px solid rgba(0,255,106,.16);
      border-radius: 28px;
      box-shadow: 0 0 0 1px rgba(255,255,255,.02), 0 24px 80px rgba(0,0,0,.55), 0 0 50px rgba(0,255,106,.12);
      backdrop-filter: blur(18px);
    }
    .meta { margin-bottom: 24px; }
    .file-name {
      font-family: 'Manrope', sans-serif; font-size: 1.55rem; font-weight: 800;
      color: #fff; line-height: 1.2; word-break: break-word; margin-bottom: 12px;
    }
    .tags { display: flex; flex-wrap: wrap; gap: 10px; }
    .tag {
      font-size: .76rem; letter-spacing: 1px; color: var(--muted);
      border: 1px solid rgba(0,255,106,.18); background: rgba(0,0,0,.28);
      padding: 6px 10px; border-radius: 999px;
    }
    .tag.hot { color: #001406; background: linear-gradient(135deg, var(--neon), var(--neon-2)); border-color: transparent; }
    /* ── Video/Media container ── */
    .media-container {
      margin: 22px 0;
      border-radius: 22px;
      overflow: hidden;
      border: 1px solid rgba(0,255,106,.14);
      background: #000;
      position: relative;
    }
    /* ── HTML5 Video ── */
    .media-container video {
      width: 100%;
      height: auto;
      min-height: 200px;
      display: block;
      background: #000;
    }
    /* ── FULLSCREEN: cover entire screen ── */
    .media-container video:fullscreen {
      width: 100vw;
      height: 100vh;
      max-width: none;
      max-height: none;
      object-fit: contain;
    }
    /* ── Audio ── */
    .audio-container {
      padding: 28px; display: grid; place-items: center; gap: 18px;
      background: linear-gradient(180deg, rgba(2,8,3,.95), rgba(0,0,0,.95));
    }
    .audio-icon { font-size: 3.6rem; filter: drop-shadow(0 0 18px var(--glow)); }
    .audio-container audio { width: 100%; }
    /* ── Image ── */
    .image-container { padding: 10px; display: flex; justify-content: center; }
    .image-container img { max-width: 100%; max-height: 700px; object-fit: contain; }
    /* ── No preview ── */
    .no-preview {
      padding: 54px 20px; text-align: center; color: var(--muted);
      display: flex; flex-direction: column; align-items: center; gap: 12px;
    }
    .no-preview-icon { font-size: 3.5rem; }
    /* ── Actions ── */
    .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 20px; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 10px;
      padding: 14px 22px; border-radius: 16px; text-decoration: none;
      font-family: 'Manrope', sans-serif; font-weight: 800; letter-spacing: .8px;
      border: 1px solid transparent; transition: transform .15s ease, box-shadow .15s ease;
    }
    .btn:hover { transform: translateY(-1px); }
    .btn-primary {
      color: #001406;
      background: linear-gradient(135deg, var(--neon), var(--neon-2));
      box-shadow: 0 0 0 1px rgba(255,255,255,.05), 0 0 26px rgba(0,255,106,.22);
    }
    .btn-primary:hover { box-shadow: 0 0 34px rgba(0,255,106,.38); }
    /* ── Bot CTA ── */
    .bot-cta {
      display: flex; align-items: center; gap: 10px;
      margin-top: 22px; padding: 14px 20px;
      background: rgba(0,255,106,.06);
      border: 1px solid rgba(0,255,106,.22); border-radius: 14px;
      text-decoration: none; color: var(--muted);
      font-family: 'Manrope',sans-serif; font-size: .88rem; font-weight: 600;
      transition: background .2s, border-color .2s, color .2s;
    }
    .bot-cta:hover { background: rgba(0,255,106,.13); border-color: var(--neon); color: #fff; }
    .bot-cta-icon { font-size: 1.2rem; flex-shrink: 0; }
    .bot-cta-btn {
      flex-shrink: 0; padding: 5px 13px;
      background: var(--neon); color: #001406;
      font-family: 'Manrope',sans-serif; font-weight: 800; font-size: .75rem;
      border-radius: 999px; white-space: nowrap;
    }
    /* ── Notices ── */
    .notices { margin-top: 16px; display: flex; flex-direction: column; gap: 8px; }
    .notice-item {
      border-radius: 14px;
      background: rgba(0,255,106,.06); border: 1px solid rgba(0,255,106,.25);
      animation: noticeIn .35s ease; overflow: hidden;
    }
    .notice-item.text-notice {
      padding: 12px 18px;
      font-family: 'Manrope',sans-serif; font-size: .97rem; font-weight: 600;
      color: var(--neon); line-height: 1.6; word-break: break-word; white-space: pre-wrap;
    }
    .notice-item.file-notice { padding: 14px 16px; }
    .notice-item.inline-only { padding: 0; background: #000; border: none; }
    .notice-item.inline-only .notice-media-wrap { border-radius: 18px; overflow: hidden; }
    .notice-item.inline-only video,
    .notice-item.inline-only img { width: 100%; max-height: 480px; object-fit: contain; display: block; background: #000; }
    .notice-link { color: var(--neon); text-decoration: underline; word-break: break-all; }
    .notice-file-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
    .notice-type-tag {
      font-size: .66rem; letter-spacing: 1.2px; padding: 3px 9px; border-radius: 999px;
      border: 1px solid rgba(0,255,106,.3); color: var(--neon); background: rgba(0,0,0,.3);
    }
    .notice-file-name { font-family: 'Manrope',sans-serif; font-weight: 700; font-size: .9rem; color: #fff; word-break: break-word; }
    .notice-media-wrap { border-radius: 10px; overflow: hidden; background: #000; margin-bottom: 12px; }
    .notice-media-wrap img { width: 100%; max-height: 320px; object-fit: contain; display: block; }
    .notice-media-wrap video, .notice-media-wrap audio { width: 100%; display: block; }
    .notice-btns { display: flex; gap: 8px; flex-wrap: wrap; }
    .notice-btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 6px 14px; border-radius: 999px; text-decoration: none;
      font-family: 'Manrope',sans-serif; font-size: .76rem; font-weight: 700;
      border: 1px solid rgba(0,255,106,.28); color: var(--muted); transition: all .15s;
    }
    .notice-btn:hover { border-color: var(--neon); color: var(--neon); background: rgba(0,255,106,.06); }
    .notice-btn.primary { background: linear-gradient(135deg, var(--neon), var(--neon-2)); color: #001406; border-color: transparent; }
    @keyframes noticeIn { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }
    /* ── Watermark ── */
    .watermark { margin-top: 36px; margin-bottom: 10px; display: flex; justify-content: center; }
    .watermark a {
      font-family: 'Manrope',sans-serif; font-size: 1.15rem; font-weight: 800;
      letter-spacing: 1px; text-decoration: none; color: #fff;
      text-shadow: 0 0 18px var(--glow); transition: opacity .2s;
    }
    .watermark a:hover { opacity: .78; }
    .watermark a span { color: var(--neon); }
    @media (max-width: 640px) {
      .card { padding: 20px; border-radius: 22px; }
      .file-name { font-size: 1.18rem; }
      .actions { flex-direction: column; }
      .btn { width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <div class="logo">File2Link<span>BOT</span></div>
  </header>
  <div class="card">
    <div class="meta">
      <div class="file-name">${escHtml(fileLabel)}</div>
      <div class="tags">
        <span class="tag hot">${escHtml(typeLabel)}</span>
        ${file.mimeType ? `<span class="tag">${escHtml(file.mimeType)}</span>` : ""}
        ${file.fileSize ? `<span class="tag">${escHtml(sizeLabel)}</span>` : ""}
        ${file.duration ? `<span class="tag">${formatDuration(file.duration)}</span>` : ""}
        ${(file.width && file.height) ? `<span class="tag">${file.width}×${file.height}</span>` : ""}
      </div>
    </div>
    ${mediaPlayer}
    <div class="actions">
      <a class="btn btn-primary" href="${downloadUrl}" download="${escHtml(fileLabel)}">⬇️ Download</a>
    </div>
    <a class="bot-cta" href="https://t.me/filetolink_05bot" target="_blank" rel="noopener noreferrer">
      <span class="bot-cta-icon">⚡</span>
      <span style="flex:1;">Convert Telegram files into instant download &amp; streaming links</span>
      <span class="bot-cta-btn">Open Bot</span>
    </a>
    <div id="notices" class="notices"></div>
  </div>
  <div class="watermark">
    <a href="https://t.me/takezo_5" target="_blank" rel="noopener noreferrer">tak<span>ezo_5</span></a>
  </div>
  <script>
    (function () {
      var noticesEl = document.getElementById('notices');
      var seenIds   = new Set();

      function escHtml(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }

      function typeLabel(b) {
        if (b.isVideo || b.fileType === 'video' || b.fileType === 'animation' || b.fileType === 'video_note') return 'VIDEO';
        if (b.isAudio || b.fileType === 'audio' || b.fileType === 'voice') return 'AUDIO';
        if (b.isImage || b.fileType === 'photo') return 'IMAGE';
        if (b.mimeType) {
          if (b.mimeType.startsWith('video/')) return 'VIDEO';
          if (b.mimeType.startsWith('audio/')) return 'AUDIO';
          if (b.mimeType.startsWith('image/')) return 'IMAGE';
        }
        return 'FILE';
      }

      function linkify(text) {
        return escHtml(text).replace(/(https?:\\/\\/[^\\s<>"']+)/g, function (m) {
          return '<a href="' + m + '" target="_blank" rel="noopener noreferrer" class="notice-link">' + m + '</a>';
        });
      }

      function addNotice(b) {
        if (seenIds.has(b.id)) return;
        seenIds.add(b.id);
        var el = document.createElement('div');
        el.className = 'notice-item';
        el.dataset.id = b.id;

        if (b.type === 'text') {
          el.classList.add('text-notice');
          el.innerHTML = linkify(b.content || '');
        } else if (b.type === 'file') {
          el.classList.add('file-notice');
          var fid = b.fileId || '';
          var raw = fid ? '/api/stream/' + fid : (b.rawStreamUrl || '');
          var vid = fid ? '/api/stream-video/' + fid : (b.videoStreamUrl || '');
          var sp  = b.streamUrl  || (fid ? '/api/stream-page/' + fid : '');
          var dl  = b.downloadUrl || (fid ? '/api/download/' + fid : '');
          var lbl = typeLabel(b);
          var name = escHtml(b.fileName || 'File');

          if (lbl === 'IMAGE' && raw) {
            el.classList.add('inline-only');
            el.innerHTML = '<div class="notice-media-wrap"><img src="' + escHtml(raw) + '" loading="lazy" alt=""></div>';
          } else if (lbl === 'VIDEO' && fid) {
            el.classList.add('inline-only');
            el.innerHTML = '<div class="notice-media-wrap"><video controls playsinline preload="metadata" style="width:100%;min-height:160px;background:#000;"><source src="' + escHtml(vid) + '" type="' + escHtml(b.mimeType || 'video/mp4') + '"></video></div>';
          } else if (lbl === 'AUDIO' && raw) {
            el.innerHTML =
              '<div class="notice-file-header"><span class="notice-type-tag">AUDIO</span><span class="notice-file-name">' + name + '</span></div>' +
              '<div class="notice-media-wrap" style="padding:12px 0;"><audio controls preload="auto" style="width:100%;"><source src="' + escHtml(raw) + '"></audio></div>';
          } else {
            var btns = '';
            if (sp) btns += '<a class="notice-btn primary" href="' + escHtml(sp) + '" target="_blank">▶ Open Page</a>';
            if (dl) btns += '<a class="notice-btn" href="' + escHtml(dl) + '" target="_blank">⬇ Download</a>';
            el.innerHTML =
              '<div class="notice-file-header"><span class="notice-type-tag">' + lbl + '</span><span class="notice-file-name">' + name + '</span></div>' +
              (btns ? '<div class="notice-btns">' + btns + '</div>' : '');
          }
        }
        noticesEl.appendChild(el);
      }

      function removeNotice(id) {
        var el = noticesEl.querySelector('[data-id="' + id + '"]');
        if (el) el.remove();
        seenIds.delete(id);
      }

      var initial = ${noticesInitial};
      initial.forEach(addNotice);

      function connectSse() {
        var es = new EventSource('/api/broadcasts/sse');
        es.onmessage = function (e) {
          try {
            var b = JSON.parse(e.data);
            if (b.type === 'text' || b.type === 'file') addNotice(b);
            else if (b.type === 'delete') removeNotice(b.id);
          } catch (_) {}
        };
        es.onerror = function () { es.close(); setTimeout(connectSse, 4000); };
      }
      connectSse();
    })();
  </script>
</body>
</html>`;

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // Netflix/YouTube-level optimization: aggressive edge caching + long stale window
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=604800, stale-if-error=2592000");
      res.setHeader("CDN-Cache-Control", "max-age=300, s-maxage=300, stale-while-revalidate=604800");
      res.setHeader("Vary", "Accept-Encoding, Accept");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      res.send(html);

    } catch (innerErr) {
      req.log.error({ innerErr }, "Stream page inner error");
      if (!res.headersSent) res.status(500).send("Server error building page");
    }
  } catch (err) {
    req.log.error({ err }, "Stream page error");
    if (!res.headersSent) res.status(500).send("Server error");
  }
});

router.get("/file-info/:id", async (req, res) => {
  try {
    const rows = await db.select().from(filesTable).where(eq(filesTable.id, req.params.id!)).limit(1);
    if (rows.length === 0) { res.status(404).json({ error: "File not found" }); return; }
    const file = rows[0]!;
    res.json({
      id: file.id, fileName: file.fileName, mimeType: file.mimeType,
      fileSize: file.fileSize, fileType: file.fileType,
      isStreamable: file.isStreamable, isAudio: file.isAudio,
      duration: file.duration, width: file.width, height: file.height,
      createdAt: file.createdAt, accessCount: file.accessCount,
    });
  } catch (err) {
    req.log.error({ err }, "File info error");
    res.status(500).json({ error: "Server error" });
  }
});

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default router;
