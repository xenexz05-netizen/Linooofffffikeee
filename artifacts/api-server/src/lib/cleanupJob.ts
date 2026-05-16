import { db, filesTable, broadcastsTable } from "@workspace/db";
import { lt } from "drizzle-orm";
import { logger } from "./logger.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const RUN_INTERVAL_MS    = 60 * 60 * 1000;  // DB cleanup every hour
const MEM_INTERVAL_MS    = 3 * 60 * 1000;   // Memory cleanup every 3 min (free tier)
const FILE_TTL_MS        = 24 * 60 * 60 * 1000;
const BROADCAST_TTL_MS   = 7 * 24 * 60 * 60 * 1000;
const HLS_ORPHAN_AGE_MS  = 5 * 60 * 1000;   // Kill HLS dirs older than 5 min

async function runDbCleanup(): Promise<void> {
  try {
    const fileCutoff      = new Date(Date.now() - FILE_TTL_MS);
    const broadcastCutoff = new Date(Date.now() - BROADCAST_TTL_MS);

    const deletedFiles = await db.delete(filesTable)
      .where(lt(filesTable.createdAt, fileCutoff))
      .returning({ id: filesTable.id });

    const deletedBroadcasts = await db.delete(broadcastsTable)
      .where(lt(broadcastsTable.createdAt, broadcastCutoff))
      .returning({ id: broadcastsTable.id });

    if (deletedFiles.length > 0 || deletedBroadcasts.length > 0) {
      logger.info({ files: deletedFiles.length, broadcasts: deletedBroadcasts.length }, "DB cleanup done");
    }
  } catch (err) {
    logger.error({ err }, "DB cleanup failed");
  }
}

function runMemoryCleanup(): void {
  try {
    const hlsRoot = path.join(os.tmpdir(), "f2l-hls");
    const now     = Date.now();

    if (fs.existsSync(hlsRoot)) {
      const entries = fs.readdirSync(hlsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const fullPath = path.join(hlsRoot, entry.name);
          const stat     = fs.statSync(fullPath);
          if (now - stat.mtimeMs > HLS_ORPHAN_AGE_MS) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            logger.debug({ dir: entry.name }, "Cleaned orphaned HLS dir");
          }
        } catch {}
      }
    }

    // Force GC whenever heap > 70% — critical on 512 MB free tier
    if (global.gc) {
      const { heapUsed, heapTotal } = process.memoryUsage();
      if (heapUsed / heapTotal > 0.70) {
        global.gc();
        logger.debug({ pct: ((heapUsed / heapTotal) * 100).toFixed(1) }, "Forced GC");
      }
    }

    // Log RSS so you can watch memory in Railway dashboard
    const { rss, heapUsed, heapTotal } = process.memoryUsage();
    const rssMB  = (rss / 1024 / 1024).toFixed(1);
    const heapMB = (heapUsed / 1024 / 1024).toFixed(1);
    const totMB  = (heapTotal / 1024 / 1024).toFixed(1);
    logger.debug({ rss: `${rssMB}MB`, heap: `${heapMB}/${totMB}MB` }, "Memory");

  } catch (err) {
    logger.error({ err }, "Memory cleanup failed");
  }
}

export function startCleanupJob(): void {
  // Enable GC exposure (pass --expose-gc at startup for this to work)
  setTimeout(runDbCleanup, 30_000).unref();
  setInterval(runDbCleanup, RUN_INTERVAL_MS).unref();

  setTimeout(runMemoryCleanup, 10_000).unref();
  setInterval(runMemoryCleanup, MEM_INTERVAL_MS).unref();

  logger.info("Cleanup jobs started (DB hourly, memory every 3 min)");
}
