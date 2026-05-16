import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const broadcastsTable = pgTable("broadcasts", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  content: text("content"),
  fileId: text("file_id"),
  fileName: text("file_name"),
  mimeType: text("mime_type"),
  fileType: text("file_type"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type BroadcastRecord = typeof broadcastsTable.$inferSelect;
