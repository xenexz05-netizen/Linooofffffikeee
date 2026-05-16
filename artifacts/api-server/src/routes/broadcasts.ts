import { Router } from "express";
import { db, broadcastsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { addSseClient, removeSseClient } from "../lib/sseClients.js";
import { isStreamable, isAudio } from "../lib/fileUtils.js";

const router = Router();

router.get("/broadcasts", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(broadcastsTable)
      .orderBy(desc(broadcastsTable.createdAt))
      .limit(30);

    const baseUrl = (() => {
      if (process.env.BASE_URL) return process.env.BASE_URL;
      return `http://localhost:${process.env.PORT || 8080}`;
    })();

    const enriched = rows.reverse().map((r) => {
      const canStream = isStreamable(r.mimeType) || isAudio(r.mimeType) ||
        r.fileType === "video" || r.fileType === "animation" || r.fileType === "video_note" ||
        r.fileType === "audio" || r.fileType === "voice";
      return {
        ...r,
        canStream,
        streamUrl: r.fileId ? `${baseUrl}/api/stream-page/${r.fileId}` : null,
        downloadUrl: r.fileId ? `${baseUrl}/api/download/${r.fileId}` : null,
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/broadcasts/sse", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(": connected\n\n");

  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(keepAlive);
    }
  }, 25000);

  addSseClient(res);

  req.on("close", () => {
    clearInterval(keepAlive);
    removeSseClient(res);
  });
});

export default router;
