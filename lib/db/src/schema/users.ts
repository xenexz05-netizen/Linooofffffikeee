import { pgTable, text, bigint, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * Tracks every unique user who has interacted with the main bot.
 * Used by the Update Bot to broadcast messages to all users.
 */
export const usersTable = pgTable("users", {
  id:        text("id").primaryKey(),
  chatId:    bigint("chat_id", { mode: "number" }).notNull().unique(),
  username:  text("username"),
  firstName: text("first_name"),
  isActive:  boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastSeen:  timestamp("last_seen").defaultNow().notNull(),
});

export type UserRecord = typeof usersTable.$inferSelect;
