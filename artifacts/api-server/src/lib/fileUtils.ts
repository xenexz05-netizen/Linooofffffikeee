export const STREAMABLE_MIME_TYPES = [
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/x-matroska",
  "video/avi",
  "video/quicktime",
  "video/x-msvideo",
  "video/3gpp",
  "video/x-flv",
  "video/mpeg",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/wav",
  "audio/flac",
  "audio/aac",
  "audio/mp4",
  "audio/webm",
  "audio/x-m4a",
];

export const AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/wav",
  "audio/flac",
  "audio/aac",
  "audio/mp4",
  "audio/webm",
  "audio/x-m4a",
];

export function isStreamable(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  return STREAMABLE_MIME_TYPES.some((m) => mimeType.startsWith(m.split("/")[0]!) && STREAMABLE_MIME_TYPES.includes(mimeType));
}

export function isAudio(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  return AUDIO_MIME_TYPES.some((m) => mimeType === m || mimeType.startsWith("audio/"));
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes) return "Unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function getFileTypeLabel(fileType: string, mimeType?: string | null): string {
  if (mimeType?.startsWith("video/")) return "Video";
  if (mimeType?.startsWith("audio/")) return "Audio";
  if (mimeType?.startsWith("image/")) return "Image";
  if (mimeType?.startsWith("application/pdf")) return "PDF";
  switch (fileType) {
    case "video": return "Video";
    case "audio": return "Audio";
    case "voice": return "Voice Message";
    case "video_note": return "Video Note";
    case "photo": return "Photo";
    case "document": return "Document";
    case "sticker": return "Sticker";
    case "animation": return "Animation";
    default: return "File";
  }
}

export function generateFileId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}
