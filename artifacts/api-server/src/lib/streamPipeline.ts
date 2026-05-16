import type { Request, Response } from "express";
import { PassThrough } from "stream";
import { pipeline } from "stream/promises";
import { logger } from "./logger.js";

// Realistic buffer size — 512 KB is enough for smooth streaming
const HIGH_WATER_MARK = 512 * 1024;   // 512 KB

export interface StreamPipelineOptions {
  chatId:    number;
  messageId: number;
  mimeType:  string;
  fileName:  string | null | undefined;
  fileSize:  number | null | undefined;
  isDownload: boolean;
  rangeHeader?: string;
  userIp?: string;
}

/**
 * streamToResponse — the core 2026 streaming function.
 *
 * Uses Node.js pipeline() for automatic backpressure, error handling, and
 * cleanup. GramJS chunks are pushed into a PassThrough stream which is
 * then piped to the HTTP response.
 *
 * This handles:
 *   - Range requests (206 Partial Content)
 *   - Full file streaming (200 OK)
 *   - Download vs inline content disposition
 *   - HEAD requests (no body)
 *   - Proper error recovery
 */
export async function streamToResponse(
  req: Request,
  res: Response,
  streamFn: (
    onChunk: (chunk: Buffer) => Promise<boolean>,
    offset: number,
    limit?: number,
  ) => Promise<void>,
  opts: StreamPipelineOptions,
): Promise<void> {
  const {
    mimeType, fileName, fileSize, isDownload, rangeHeader, userIp,
  } = opts;

  const contentType = mimeType || "application/octet-stream";
  const fSize = fileSize ?? 0;

  // ── Tune socket for streaming ──────────────────────────────────────────────
  const sock = res.socket;
  if (sock) {
    sock.setNoDelay(true);           // Disable Nagle — send chunks immediately
    sock.setKeepAlive(true, 30000);  // Keep TCP alive between chunks
    sock.setTimeout(0);              // No idle timeout for streaming
    sock.setMaxListeners(20);
  }

  // ── HEAD request — return headers only, no body ────────────────────────────
  if (req.method === "HEAD") {
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", contentType);
    if (fSize) res.setHeader("Content-Length", String(fSize));
    res.setHeader("ETag", `"${opts.chatId}-${opts.messageId}"`);
    res.status(200).end();
    return;
  }

  // ── Range request handling ─────────────────────────────────────────────────
  let offset = 0;
  let limit: number | undefined;

  if (rangeHeader && fSize > 0) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0] ?? "0", 10);
    const end   = parts[1] ? parseInt(parts[1], 10) : fSize - 1;
    const chunkSize = end - start + 1;
    offset = start;
    limit  = chunkSize;

    res.status(206);
    res.setHeader("Content-Range",  `bytes ${start}-${end}/${fSize}`);
    res.setHeader("Accept-Ranges",  "bytes");
    res.setHeader("Content-Length", String(chunkSize));
    res.setHeader("Content-Type",   contentType);
  } else {
    res.status(200);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type",  contentType);
    if (fSize) res.setHeader("Content-Length", String(fSize));
  }

  // ── Content-Disposition ────────────────────────────────────────────────────
  if (fileName) {
    const safe    = fileName.replace(/[\\/:*?"<>|]+/g, "_");
    const encoded = encodeURIComponent(safe);
    res.setHeader(
      "Content-Disposition",
      isDownload
        ? `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`
        : `inline; filename="${safe}"; filename*=UTF-8''${encoded}`,
    );
  }

  // ── Caching headers ────────────────────────────────────────────────────────
  res.setHeader("Cache-Control", isDownload
    ? "private, max-age=86400, must-revalidate"
    : "private, max-age=3600, must-revalidate");
  res.setHeader("ETag", `"${opts.chatId}-${opts.messageId}"`);
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Keep-Alive",  "timeout=75, max=1000");
  res.setHeader("X-Content-Type-Options", "nosniff");

  // ── PassThrough for backpressure ───────────────────────────────────────────
  const pass = new PassThrough({ highWaterMark: HIGH_WATER_MARK });
  let aborted = false;

  req.on("close", () => {
    aborted = true;
    if (!pass.destroyed) pass.destroy();
  });

  // Feed GramJS chunks into PassThrough (respecting backpressure)
  const onChunk = async (chunk: Buffer): Promise<boolean> => {
    if (aborted || pass.destroyed) return false;
    const ok = pass.push(chunk);
    if (!ok) {
      // PassThrough buffer full — wait for drain before accepting more
      await new Promise<void>((resolve) => {
        const onDrain = () => { pass.off("close", onClose); resolve(); };
        const onClose = () => { aborted = true; pass.off("drain", onDrain); resolve(); };
        pass.once("drain", onDrain);
        pass.once("close", onClose);
      });
    }
    return !aborted;
  };

  // Start streaming in background — feeds chunks into PassThrough
  streamFn(onChunk, offset, limit)
    .then(() => {
      if (!pass.destroyed) pass.push(null);  // Signal EOF
    })
    .catch((err) => {
      if (!pass.destroyed) pass.destroy(err);
    });

  // pipeline() manages the PassThrough→Response pipe:
  // - Respects backpressure automatically
  // - Cleans up on error or completion
  // - Throws on EPIPE/ECONNRESET (client disconnect) — we catch and ignore
  try {
    await pipeline(pass, res);
  } catch (err: any) {
    const code = err?.code;
    const ignorable = ["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED",
                       "ERR_STREAM_PREMATURE_CLOSE", "ERR_HTTP_SOCKET_ENCODING"];
    if (!ignorable.includes(code)) {
      logger.error({ err, ...opts }, "Stream pipeline error");
    }
  }
}
