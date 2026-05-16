import { pgTable, text, bigint, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const filesTable = pgTable("files", {
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull(),
  fileUniqueId: text("file_unique_id").notNull().unique(),
  fileName: text("file_name"),
  mimeType: text("mime_type"),
  fileSize: bigint("file_size", { mode: "number" }),
  fileType: text("file_type").notNull(),
  fromUserId: bigint("from_user_id", { mode: "number" }),
  fromUsername: text("from_username"),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  messageId: bigint("message_id", { mode: "number" }).notNull(),
  caption: text("caption"),
  duration: integer("duration"),
  width: integer("width"),
  height: integer("height"),
  isStreamable: boolean("is_streamable").default(false),
  isAudio: boolean("is_audio").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  accessCount: bigint("access_count", { mode: "number" }).default(0),
});

export const insertFileSchema = createInsertSchema(filesTable).omit({ createdAt: true, accessCount: true });
export type InsertFile = z.infer<typeof insertFileSchema>;
export type FileRecord = typeof filesTable.$inferSelect;
