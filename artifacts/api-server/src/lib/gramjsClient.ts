// artifacts/api-server/src/lib/gramjsClient.ts
// ── 5-SLOT MTProto POOL — load balancing + failover ──────────────────────────
// All slots share ONE bot token. Each slot uses a different API_ID+API_HASH pair
// registered at https://my.telegram.org so Telegram sees spread traffic.
// ─────────────────────────────────────────────────────────────────────────────

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { ConnectionTCPFull } from "telegram/network/connection/TCPFull.js";
import bigInt from "big-integer";
import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger.js";

// ── Single bot token shared by all pool slots ─────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const PROXY_URL = process.env.TELEGRAM_PROXY;

// ── Streaming constants (unchanged from original) ─────────────────────────────
const REQUEST_SIZE = 1 * 1024 * 1024; // 1 MB — safe for Railway free tier
const WORKERS      = 4;               // 4 workers = 4 MB max in-flight

// ── Slot descriptor ───────────────────────────────────────────────────────────
interface SlotConfig {
  index:   number;       // 1-based slot number
  apiId:   number;
  apiHash: string;
  sessionEnvKey:  string; // e.g. "TELEGRAM_SESSION"
  sessionFilePath: string; // e.g. "telegram_session.txt"
}

interface PoolSlot {
  config:  SlotConfig;
  client:  TelegramClient | null;
  healthy: boolean;
  coolUntil: number; // epoch ms — slot is skipped until this time (flood wait)
  errorCount: number;
}

// ── Build slot config list from env vars ──────────────────────────────────────
// Slot 1 is always required. Slots 2-5 are optional — only added if both
// API_ID_N and API_HASH_N are set.
function buildSlotConfigs(): SlotConfig[] {
  const configs: SlotConfig[] = [];

  const slots = [
    { suffix: "",  index: 1 },
    { suffix: "_2", index: 2 },
    { suffix: "_3", index: 3 },
    { suffix: "_4", index: 4 },
    { suffix: "_5", index: 5 },
  ];

  for (const { suffix, index } of slots) {
    const rawId   = process.env[`TELEGRAM_API_ID${suffix}`];
    const apiHash = process.env[`TELEGRAM_API_HASH${suffix}`];

    if (!rawId || !apiHash) {
      if (index === 1) throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required");
      continue; // optional slots — skip if not configured
    }

    const apiId = parseInt(rawId, 10);
    if (isNaN(apiId)) throw new Error(`TELEGRAM_API_ID${suffix} must be a number`);

    configs.push({
      index,
      apiId,
      apiHash,
      sessionEnvKey:   `TELEGRAM_SESSION${suffix}`,
      sessionFilePath: path.resolve(`telegram_session${suffix === "" ? "" : suffix}.txt`),
    });
  }

  return configs;
}

// ── Session helpers ───────────────────────────────────────────────────────────
function loadSession(slot: SlotConfig): string {
  const env = process.env[slot.sessionEnvKey]?.trim();
  if (env) return env;
  try { return fs.readFileSync(slot.sessionFilePath, "utf-8").trim(); } catch { return ""; }
}

function saveSession(slot: SlotConfig, session: string): void {
  if (process.env[slot.sessionEnvKey]) return; // env var takes precedence — don't overwrite
  try { fs.writeFileSync(slot.sessionFilePath, session, "utf-8"); } catch (err) {
    logger.warn({ err, slot: slot.index }, "Could not save session file");
  }
}

// ── Create one TelegramClient for a slot ─────────────────────────────────────
async function createSlotClient(slot: SlotConfig): Promise<TelegramClient> {
  const sessionStr = loadSession(slot);

  let proxyConfig: any = undefined;
  if (PROXY_URL) {
    try {
      const url = new URL(PROXY_URL);
      if (url.protocol === "socks5:") {
        proxyConfig = {
          type:     "socks5",
          ip:       url.hostname,
          port:     parseInt(url.port || "1080", 10),
          username: url.username || undefined,
          password: url.password || undefined,
        };
        logger.info({ slot: slot.index, proxy: url.hostname }, "Using SOCKS5 proxy");
      }
    } catch (err) {
      logger.warn({ err, url: PROXY_URL, slot: slot.index }, "Invalid TELEGRAM_PROXY — ignoring");
    }
  }

  const client = new TelegramClient(
    new StringSession(sessionStr),
    slot.apiId,
    slot.apiHash,
    {
      connectionRetries: 25,
      retryDelay:        250,
      connection:        ConnectionTCPFull,
      proxy:             proxyConfig,
      useWSS:            false,
      autoReconnect:     true,
      deviceModel:       "File2Link BOT",
      appVersion:        "3.0.0",
      langCode:          "en",
      maxCdnConnections: 16,
    },
  );

  await client.start({
    botAuthToken: BOT_TOKEN,
    onError: (err) => logger.error({ err, slot: slot.index }, "GramJS error"),
  });

  const saved = client.session.save() as unknown as string;
  if (saved && saved !== sessionStr) saveSession(slot, saved);

  logger.info({ slot: slot.index, apiId: slot.apiId, workers: WORKERS, chunkMB: REQUEST_SIZE / 1024 / 1024 }, "MTProto slot ready");

  // Keep-alive
  setInterval(async () => {
    try {
      if (client && !client.connected) {
        await client.connect();
        logger.info({ slot: slot.index }, "Reconnected");
      }
    } catch (err) {
      logger.error({ err, slot: slot.index }, "Keep-alive failed");
    }
  }, 30_000).unref();

  return client;
}

// ── Pool state ────────────────────────────────────────────────────────────────
let _pool: PoolSlot[] = [];
let _initializing: Promise<void> | null = null;
let _initialized = false;

// ── Public: initialize all configured slots ───────────────────────────────────
export async function initializeClients(): Promise<void> {
  if (_initialized) return;
  if (_initializing) return _initializing;

  _initializing = (async () => {
    const configs = buildSlotConfigs();
    logger.info({ totalSlots: configs.length }, "Initializing MTProto pool");

    // Initialize all slots in parallel for faster startup
    const results = await Promise.allSettled(
      configs.map(async (config) => {
        const slot: PoolSlot = {
          config,
          client:     null,
          healthy:    false,
          coolUntil:  0,
          errorCount: 0,
        };

        try {
          slot.client  = await createSlotClient(config);
          slot.healthy = true;
        } catch (err) {
          logger.error({ err, slot: config.index }, "Failed to initialize MTProto slot — slot excluded from pool");
          // Slot stays in pool with healthy=false; won't be selected
        }

        return slot;
      }),
    );

    _pool = results.map((r) => (r.status === "fulfilled" ? r.value : null)).filter(Boolean) as PoolSlot[];

    const healthy = _pool.filter((s) => s.healthy).length;
    if (healthy === 0) throw new Error("No MTProto slots could be initialized — check credentials");

    logger.info({ healthySlots: healthy, totalSlots: _pool.length }, "MTProto pool ready");
    _initialized = true;
  })();

  try {
    await _initializing;
  } finally {
    _initializing = null;
  }
}

// ── Internal: pick next healthy slot (skip cooling down) ─────────
function getNextSlot(): PoolSlot | null {
  const now = Date.now();
  const total = _pool.length;
  if (total === 0) return null;

  // Try to find the first available slot (slots are ordered by primary first)
  for (let i = 0; i < total; i++) {
    const slot = _pool[i]!;
    const available = slot.healthy && slot.client !== null && now >= slot.coolUntil;
    if (available) {
      return slot;
    }
  }

  // All slots cooling — find the one that recovers soonest and wait
  return null;
}

// ── Internal: mark slot as flood-wait cooling ─────────────────────────────────
function markFloodWait(slot: PoolSlot, waitSeconds: number): void {
  slot.coolUntil = Date.now() + (waitSeconds + 2) * 1000;
  logger.warn({ slot: slot.config.index, waitSeconds }, "Slot cooling down (FLOOD_WAIT)");
}

// ── Internal: attempt stream on one specific slot ────────────────────────────
async function streamOnSlot(
  slot: PoolSlot,
  chatId: number,
  messageId: number,
  onChunk: (chunk: Buffer) => boolean | Promise<boolean>,
  offsetBytes: number,
  limitBytes: number | undefined,
): Promise<void> {
  const client = slot.client!;
  if (!client.connected) await client.connect();

  const [message] = await client.getMessages(chatId, { ids: [messageId] });
  if (!message?.media) throw new Error("No media in message");

  const aligned   = Math.floor(offsetBytes / 4096) * 4096;
  const skipBytes = offsetBytes - aligned;
  let sent    = 0;
  let skipped = 0;

  for await (const chunk of client.iterDownload({
    file:        message.media as any,
    offset:      bigInt(aligned),
    requestSize: REQUEST_SIZE,
    workers:     WORKERS,
  })) {
    const buf = Buffer.from(chunk);

    let start = 0;
    if (skipBytes > 0 && skipped < skipBytes) {
      const need = skipBytes - skipped;
      if (buf.length <= need) { skipped += buf.length; continue; }
      start   = need;
      skipped = skipBytes;
    }

    const slice = start > 0 ? buf.subarray(start) : buf;

    if (limitBytes !== undefined && sent + slice.length >= limitBytes) {
      await onChunk(slice.subarray(0, limitBytes - sent));
      break;
    }

    if (!await onChunk(slice)) break;
    sent += slice.length;
  }

  // Persist updated session
  try {
    const cur = client.session.save() as unknown as string;
    if (cur) saveSession(slot.config, cur);
  } catch {}
}

// ── Public: stream file — load-balanced across pool with failover ─────────────
export async function streamFileByMessage(
  chatId:      number,
  messageId:   number,
  onChunk:     (chunk: Buffer) => boolean | Promise<boolean>,
  offsetBytes  = 0,
  limitBytes?: number,
  userIp?:     string, // kept for API compatibility
): Promise<void> {
  await initializeClients();

  const MAX_ATTEMPTS = Math.min(_pool.length * 2, 10); // try each slot up to twice
  const BASE_DELAY   = 600;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const slot = getNextSlot();

    if (!slot) {
      // All slots in flood-wait — find shortest remaining cooldown and wait
      const now      = Date.now();
      const soonest  = _pool.reduce((min, s) => Math.min(min, s.coolUntil), Infinity);
      const waitMs   = Math.max(soonest - now, 1000);
      logger.warn({ waitMs }, "All MTProto slots cooling — waiting");
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    try {
      logger.debug({ slot: slot.config.index, attempt, chatId, messageId }, "Streaming via MTProto slot");
      await streamOnSlot(slot, chatId, messageId, onChunk, offsetBytes, limitBytes);
      slot.errorCount = 0; // reset on success
      return; // success — done

    } catch (err: any) {
      lastError = err;
      const msg = String(err?.message || err);

      logger.warn({ err: msg, slot: slot.config.index, attempt, chatId, messageId }, "Slot stream attempt failed");

      // Parse FLOOD_WAIT
      const floodMatch = msg.match(/FLOOD_WAIT_(\d+)/);
      if (floodMatch) {
        const waitSec = parseInt(floodMatch[1]!, 10);
        markFloodWait(slot, waitSec);
        // Don't count as permanent error — slot recovers automatically
        // Instead of breaking, continue the loop to select the *next* healthy slot via getNextSlot()
        continue;
      }

      // Transient errors — short backoff then try next slot
      slot.errorCount++;
      if (slot.errorCount >= 5) {
        slot.healthy = false;
        logger.error({ slot: slot.config.index }, "Slot marked unhealthy after 5 consecutive errors");

        // Auto-recover after 2 minutes
        setTimeout(() => {
          slot.errorCount = 0;
          slot.healthy    = true;
          logger.info({ slot: slot.config.index }, "Slot re-enabled after cooldown");
        }, 120_000);
      }

      const delayMs = BASE_DELAY * Math.pow(1.5, attempt - 1);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  throw lastError ?? new Error("All MTProto pool slots exhausted");
}
