import type { Request, Response } from "express";
import { streamFileByMessage } from "./gramjsClient.js";
import { streamToResponse } from "./streamPipeline.js";

export async function streamTelegramFile(
  req: Request,
  res: Response,
  chatId: number,
  messageId: number,
  mimeType: string | null | undefined,
  fileName: string | null | undefined,
  fileSize: number | null | undefined,
  isDownload = false,
): Promise<void> {
  const userIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
                 || req.socket?.remoteAddress;

  await streamToResponse(req, res,
    (onChunk, offset, limit) => streamFileByMessage(chatId, messageId, onChunk, offset, limit, userIp),
    { chatId, messageId, mimeType: mimeType || "", fileName: fileName || null, fileSize: fileSize || 0, isDownload,
      rangeHeader: req.headers["range"], userIp }
  );
}
