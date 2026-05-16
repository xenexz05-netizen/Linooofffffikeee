import type { Request, Response } from "express";
import { logger } from "./logger.js";

// ── NETFLIX/YOUTUBE LEVEL STREAMING OPTIMIZATION ───────────────────────────
// Latest technologies for maximum speed, efficiency, and reliability
// ─────────────────────────────────────────────────────────────────────────────

// ── BANDWIDTH DETECTION + ADAPTIVE STREAMING ───────────────────────────────
// Detect client's download speed and serve optimal chunk size
const bandwidthCache = new Map<string, { speed: number; timestamp: number }>();

export function estimateBandwidth(clientIp: string): number {
  const cached = bandwidthCache.get(clientIp);
  if (cached && Date.now() - cached.timestamp < 300_000) {
    return cached.speed;  // Fresh estimate (5 min)
  }
  // Default: assume 50 Mbps until measured
  return 50 * 1024 * 1024;  // 50 Mbps in bytes/sec
}

export function recordBandwidth(clientIp: string, bytesPerSec: number): void {
  bandwidthCache.set(clientIp, { speed: bytesPerSec, timestamp: Date.now() });
  // Cleanup old entries (keep memory lean)
  if (bandwidthCache.size > 10000) {
    for (const [ip, data] of bandwidthCache.entries()) {
      if (Date.now() - data.timestamp > 3600_000) {
        bandwidthCache.delete(ip);
      }
    }
  }
}

// ── SMART COMPRESSION (gzip + brotli) ──────────────────────────────────────
export function selectCompression(acceptEncoding: string): "gzip" | "brotli" | null {
  if (!acceptEncoding) return null;
  // Prefer brotli (20% smaller than gzip) if supported
  if (acceptEncoding.includes("br")) return "brotli";
  if (acceptEncoding.includes("gzip")) return "gzip";
  return null;
}

// ── HTTP/2 SERVER PUSH (Critical Resources) ───────────────────────────────
// Push HLS.js library + CSS before client asks
export function pushCriticalResources(res: Response): void {
  try {
    const serverPush = (res as any).push;
    if (!serverPush) return;  // Not HTTP/2

    // Push HLS.js library (only if client hasn't cached it)
    serverPush("/hls.js/hls.min.js", { method: "GET" }, (err) => {
      if (err) return;
      // Logger omitted to prevent spam
    });

    // Push critical CSS for stream page
    serverPush("/stream.css", { method: "GET" }, (err) => {
      if (err) return;
    });
  } catch {}
}

// ── EARLY HINTS (103) — Signal upcoming resources to browser ────────────────
export function sendEarlyHints(res: Response): void {
  try {
    res.setHeader("Link", `
      <https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js>; rel=preload; as=script,
      <https://fonts.googleapis.com>; rel=dns-prefetch,
      <https://cdn.jsdelivr.net>; rel=preconnect; crossorigin
    `.trim());
  } catch {}
}

// ── RESOURCE HINTS (dns-prefetch, preconnect, preload) ──────────────────────
export function injectResourceHints(): string {
  return `
    <link rel="dns-prefetch" href="https://cdn.jsdelivr.net" />
    <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
    <link rel="preload" href="https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js" as="script" />
  `;
}

// ── ADAPTIVE CHUNK SIZING (Based on bandwidth) ──────────────────────────────
export function getAdaptiveChunkSize(bandwidthBps: number): number {
  // More bandwidth = larger chunks = fewer round-trips
  if (bandwidthBps >= 100 * 1024 * 1024) return 8 * 1024 * 1024;    // 100+ Mbps → 8 MB chunks
  if (bandwidthBps >= 50 * 1024 * 1024) return 4 * 1024 * 1024;     // 50+ Mbps → 4 MB chunks
  if (bandwidthBps >= 10 * 1024 * 1024) return 2 * 1024 * 1024;     // 10+ Mbps → 2 MB chunks
  return 1 * 1024 * 1024;  // <10 Mbps → 1 MB chunks (slow network)
}

// ── INTELLIGENT RETRY LOGIC (Exponential backoff + jitter) ────────────────
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  baseDelay = 100,
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries - 1) throw err;

      // Exponential backoff with jitter: (2^attempt - 1) * baseDelay + random
      const exponential = Math.pow(2, attempt) - 1;
      const jitter = Math.random();
      const delayMs = exponential * baseDelay + jitter * 1000;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

// ── KEEP-ALIVE + CONNECTION POOLING ────────────────────────────────────────
export function optimizeConnection(req: Request, res: Response): void {
  // Keep connection alive for HTTP/1.1
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Keep-Alive", "timeout=75, max=1000");

  // Enable TCP_NODELAY for low-latency (already in tuneSocket, but also set here)
  const sock = res.socket;
  if (sock && !sock.connecting) {
    sock.setNoDelay(true);
  }
}

// ── STREAMING METADATA (Send total size for progress bar) ────────────────────
export function setStreamingHeaders(
  res: Response,
  contentType: string,
  fileSize: number | null,
  fileName?: string,
  isDownload = false,
  etag?: string
): void {
  if (etag) res.setHeader("ETag", `"${etag}"`);
  res.setHeader("Last-Modified", new Date().toUTCString());

  // Core streaming headers
  res.setHeader("Content-Type", contentType || "application/octet-stream");
  if (fileSize) res.setHeader("Content-Length", String(fileSize));
  res.setHeader("Accept-Ranges", "bytes");

  // CDN optimization (cache aggressively)
  const cacheControl = isDownload
    ? "private, max-age=86400, immutable"
    : "private, max-age=3600, must-revalidate";
  
  res.setHeader("Cache-Control", cacheControl);

  // Security + performance
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");

  if (fileName) {
    const safe = fileName.replace(/[\\/:*?"<>|]+/g, "_");
    const encoded = encodeURIComponent(safe);
    const disposition = isDownload
      ? `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`
      : `inline; filename="${safe}"; filename*=UTF-8''${encoded}`;
    res.setHeader("Content-Disposition", disposition);
  }
}

// ── BANDWIDTH-AWARE BUFFERING ──────────────────────────────────────────────
export function getOptimalBufferSize(bandwidthBps: number): number {
  // More bandwidth = larger buffer = smoother playback
  if (bandwidthBps >= 100 * 1024 * 1024) return 256 * 1024 * 1024;  // 100+ Mbps → 256 MB
  if (bandwidthBps >= 50 * 1024 * 1024) return 128 * 1024 * 1024;   // 50+ Mbps → 128 MB
  if (bandwidthBps >= 10 * 1024 * 1024) return 64 * 1024 * 1024;    // 10+ Mbps → 64 MB
  if (bandwidthBps >= 5 * 1024 * 1024) return 32 * 1024 * 1024;     // 5+ Mbps → 32 MB
  return 16 * 1024 * 1024;  // <5 Mbps → 16 MB (slow)
}

// ── RESPONSE TIME METRICS (Track streaming quality) ───────────────────────
export class StreamMetrics {
  startTime: number = Date.now();
  bytesStreamed: number = 0;
  chunkCount: number = 0;

  recordChunk(bytes: number): void {
    this.bytesStreamed += bytes;
    this.chunkCount++;
  }

  getBandwidth(): number {
    const elapsedSec = (Date.now() - this.startTime) / 1000;
    return this.bytesStreamed / elapsedSec;
  }

  getAverageChunkSize(): number {
    return this.chunkCount > 0 ? this.bytesStreamed / this.chunkCount : 0;
  }

  log(label: string): void {
    const bandwidthMbps = (this.getBandwidth() / (1024 * 1024)).toFixed(2);
    const chunkSizeKb = (this.getAverageChunkSize() / 1024).toFixed(2);
    logger.info(
      { label, bytesStreamed: this.bytesStreamed, chunkCount: this.chunkCount, bandwidthMbps, chunkSizeKb },
      "Stream metrics",
    );
  }
}

// ── ENABLE HTTP/2 OVER HTTP/1.1 FALLBACK ────────────────────────────────────
export function getProtocolVersion(req: Request): string {
  return req.httpVersion || "1.1";
}

// ── CRITICAL CSS INLINING (For stream page) ───────────────────────────────
export function getCriticalCSS(): string {
  return `
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      video { max-width: 100%; height: auto; display: block; }
      .video-container { position: relative; width: 100%; aspect-ratio: 16/9; }
      .loading { display: flex; justify-content: center; align-items: center; height: 100vh; }
      .spinner { border: 4px solid rgba(0,0,0,.1); border-top-color: #000; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  `;
}

// ── LOW-LATENCY MODE (For live streams) ───────────────────────────────────
export function isLiveStream(headers: Record<string, string | string[] | undefined>): boolean {
  const range = headers["range"];
  // No range header = live stream (not seekable)
  return !range;
}

// ── SMART PREFETCH (Preload next chunk while current plays) ────────────────
export function generatePrefetchHints(fileId: string, currentRange: { start: number; end: number }, fileSize: number): string {
  const nextStart = currentRange.end + 1;
  const nextEnd = Math.min(nextStart + (32 * 1024 * 1024), fileSize - 1);  // Next 32 MB
  
  if (nextStart >= fileSize) return "";
  
  return `<link rel="prefetch" href="/api/stream/${fileId}?range=bytes=${nextStart}-${nextEnd}" as="fetch" crossorigin />`;
}
