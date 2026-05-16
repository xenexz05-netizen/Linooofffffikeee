import * as fs from "fs";
import { logger } from "./logger.js";

const TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CacheEntry {
  path: string;
  size: number;
  expiresAt: number;
  processing?: Promise<void>;
  progress: number; // 0–100
  status: "idle" | "downloading" | "remuxing" | "ready" | "error";
}

const cache = new Map<string, CacheEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (!entry.processing && entry.expiresAt < now) {
      try { fs.unlinkSync(entry.path); } catch {}
      cache.delete(key);
      logger.debug({ key }, "videoCache: evicted");
    }
  }
}, 5 * 60 * 1000).unref();

export function getCached(videoId: string): { path: string; size: number } | null {
  const entry = cache.get(videoId);
  if (!entry || entry.status !== "ready") return null;
  if (entry.expiresAt < Date.now()) {
    try { fs.unlinkSync(entry.path); } catch {}
    cache.delete(videoId);
    return null;
  }
  entry.expiresAt = Date.now() + TTL_MS;
  return { path: entry.path, size: entry.size };
}

export function getProgress(videoId: string): { progress: number; status: string } {
  const entry = cache.get(videoId);
  if (!entry) return { progress: 0, status: "idle" };
  return { progress: entry.progress, status: entry.status };
}

export function getProcessing(videoId: string): Promise<void> | null {
  const entry = cache.get(videoId);
  return (entry?.processing && entry.status !== "ready" && entry.status !== "error")
    ? entry.processing
    : null;
}

export function setProcessing(videoId: string, promise: Promise<void>): void {
  cache.set(videoId, { path: "", size: 0, expiresAt: 0, processing: promise, progress: 0, status: "downloading" });
}

export function setProgress(videoId: string, progress: number, status: "downloading" | "remuxing"): void {
  const entry = cache.get(videoId);
  if (entry) { entry.progress = progress; entry.status = status; }
}

export function setReady(videoId: string, path: string, size: number): void {
  cache.set(videoId, { path, size, expiresAt: Date.now() + TTL_MS, progress: 100, status: "ready" });
}

export function setError(videoId: string): void {
  const entry = cache.get(videoId);
  if (entry) { entry.status = "error"; entry.processing = undefined; }
}

export function evict(videoId: string): void {
  const entry = cache.get(videoId);
  if (entry) {
    try { if (entry.path) fs.unlinkSync(entry.path); } catch {}
    cache.delete(videoId);
  }
}
