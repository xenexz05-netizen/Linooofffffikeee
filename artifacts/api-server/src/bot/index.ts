import { Telegraf, Markup } from "telegraf";
import { db, filesTable, usersTable, broadcastsTable } from "@workspace/db";
import { eq, inArray, desc } from "drizzle-orm";
import type { BroadcastRecord } from "@workspace/db";
import { isStreamable, isAudio, generateFileId } from "../lib/fileUtils.js";
import { logger } from "../lib/logger.js";
import { broadcastSse } from "../lib/sseClients.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID!;
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;
const REQUIRED_CHANNEL_ID = process.env.REQUIRED_CHANNEL_ID ? Number(process.env.REQUIRED_CHANNEL_ID) : -1003792781847;
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || "PrimeAutoBotz";
const BOT_USERNAME = process.env.BOT_USERNAME || "filetolink_05bot";

export const bot = new Telegraf(BOT_TOKEN);

// ── Two-step state for /pushclear ─────────────────────────────────────────────
type ClearState = { step: "awaitingSelection"; items: BroadcastRecord[] };
const clearStates = new Map<number, ClearState>();

/** Track every user so /goforuser can broadcast to them */
async function upsertUser(ctx: any): Promise<void> {
  try {
    const userId = ctx.from?.id;
    if (!userId) return;
    const chatId    = ctx.chat?.id ?? userId;
    const username  = ctx.from?.username || null;
    const firstName = ctx.from?.first_name || null;
    const now       = new Date();
    const existing  = await db.select().from(usersTable).where(eq(usersTable.chatId, chatId)).limit(1);
    if (existing.length > 0) {
      await db.update(usersTable).set({ username, firstName, lastSeen: now, isActive: true }).where(eq(usersTable.chatId, chatId));
    } else {
      await db.insert(usersTable).values({ id: generateFileId(), chatId, username, firstName, isActive: true, createdAt: now, lastSeen: now });
    }
  } catch (err) {
    logger.warn({ err }, "upsertUser failed");
  }
}

function getBaseUrl(): string {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  return `http://localhost:${process.env.PORT || 8080}`;
}

// ── Channel membership check ──────────────────────────────────────────────────
async function isUserChannelMember(userId: number): Promise<boolean> {
  try {
    const member = await bot.telegram.getChatMember(REQUIRED_CHANNEL_ID, userId);
    return ["member", "administrator", "creator", "restricted"].includes(member.status);
  } catch (err: any) {
    logger.error({ err: err?.message || err, userId }, "Error checking channel membership");
    return false;
  }
}

async function sendForceJoinMessage(ctx: any) {
  const channelUrl = CHANNEL_USERNAME.startsWith("http") ? CHANNEL_USERNAME : `https://t.me/${CHANNEL_USERNAME.replace(/^@/, "")}`;
  const joinButton = Markup.inlineKeyboard([
    [Markup.button.url("🚀 Join Channel", channelUrl)],
    [Markup.button.callback("✅ Check Join", "check_join")],
  ]);
  await ctx.replyWithHTML(
    `🔒 <b>Join Channel</b>\n\n` +
    `You must join <b>${CHANNEL_USERNAME}</b> to use this bot.\n\n` +
    `👇 Click the button below to join ${CHANNEL_USERNAME} community and get started! 🌐`,
    joinButton,
  );
}

// ── Membership middleware (private chats only) ────────────────────────────────
bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== "private") return next();
  const userId = ctx.from?.id;
  if (!userId) return next();

  // Admin bypasses membership check
  if (ADMIN_ID && userId === ADMIN_ID) return next();

  const isMember = await isUserChannelMember(userId);
  if (!isMember) {
    try {
      await sendForceJoinMessage(ctx);
    } catch (err: any) {
      if (err?.response?.error_code === 403) {
        logger.warn({ userId, errorCode: 403 }, "Bot blocked by user");
      } else {
        logger.error({ err: err?.message || err, userId }, "Failed to send force join message");
      }
    }
    return;
  }
  return next();
});

// ── check_join callback ───────────────────────────────────────────────────────
bot.action("check_join", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    try { await ctx.answerCbQuery("❌ Error: Could not identify user", { show_alert: true }); } catch {}
    return;
  }
  try {
    const isMember = await isUserChannelMember(userId);
    if (isMember) {
      try { await ctx.deleteMessage(); } catch {}
      await ctx.answerCbQuery("✅ Welcome! You can now use the bot 🎉", { show_alert: true });
      await ctx.reply(
        `🎉 <b>Welcome to ${BOT_USERNAME}!</b>\n\n` +
        `📤 Forward any file to me and I'll generate:\n` +
        `⬇️ A direct <b>download link</b>\n` +
        `▶️ A <b>stream link</b> for videos and audio\n\n` +
        `📤 <i>Just forward or send any file to get started!</i>`,
        { parse_mode: "HTML" }
      );
    } else {
      await ctx.answerCbQuery(
        "❌ You haven't joined the channel yet. Please join first.",
        { show_alert: true }
      );
    }
  } catch (err: any) {
    if (err?.response?.error_code !== 403) {
      logger.error({ err: err?.message || err, userId }, "Error in check_join callback");
    }
  }
});

// ── Log to channel helper ─────────────────────────────────────────────────────
async function logToChannel(
  fromChatId: number,
  fromMessageId: number,
  logText: string,
): Promise<{ logChatId: number; logMessageId: number } | null> {
  if (!LOG_CHANNEL_ID) {
    logger.warn("LOG_CHANNEL_ID is not set — skipping log channel forward");
    return null;
  }
  try {
    const forwarded = await bot.telegram.forwardMessage(LOG_CHANNEL_ID, fromChatId, fromMessageId);
    await bot.telegram.sendMessage(LOG_CHANNEL_ID, logText, { parse_mode: "HTML" });
    logger.info({ logChatId: forwarded.chat.id, logMessageId: forwarded.message_id }, "Forwarded to log channel");
    return { logChatId: forwarded.chat.id, logMessageId: forwarded.message_id };
  } catch (err: any) {
    logger.error({ err: err?.message || err }, "Failed to forward to log channel");
    return null;
  }
}

// ── Extract file metadata from a Telegram message object ─────────────────────
// Returns null if the message contains no supported media.
function extractFileMetadata(msg: any): {
  fileId: string;
  fileUniqueId: string;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  fileType: string;
  duration: number | null;
  width: number | null;
  height: number | null;
} | null {
  if (msg.document) {
    return { fileId: msg.document.file_id, fileUniqueId: msg.document.file_unique_id,
      fileName: msg.document.file_name || null, mimeType: msg.document.mime_type || null,
      fileSize: msg.document.file_size || null, fileType: "document",
      duration: null, width: null, height: null };
  }
  if (msg.video) {
    return { fileId: msg.video.file_id, fileUniqueId: msg.video.file_unique_id,
      fileName: msg.video.file_name || null, mimeType: msg.video.mime_type || "video/mp4",
      fileSize: msg.video.file_size || null, fileType: "video",
      duration: msg.video.duration || null, width: msg.video.width || null, height: msg.video.height || null };
  }
  if (msg.audio) {
    return { fileId: msg.audio.file_id, fileUniqueId: msg.audio.file_unique_id,
      fileName: msg.audio.file_name || msg.audio.title || null, mimeType: msg.audio.mime_type || "audio/mpeg",
      fileSize: msg.audio.file_size || null, fileType: "audio",
      duration: msg.audio.duration || null, width: null, height: null };
  }
  if (msg.voice) {
    return { fileId: msg.voice.file_id, fileUniqueId: msg.voice.file_unique_id,
      fileName: "voice_message.ogg", mimeType: msg.voice.mime_type || "audio/ogg",
      fileSize: msg.voice.file_size || null, fileType: "voice",
      duration: msg.voice.duration || null, width: null, height: null };
  }
  if (msg.video_note) {
    return { fileId: msg.video_note.file_id, fileUniqueId: msg.video_note.file_unique_id,
      fileName: "video_note.mp4", mimeType: "video/mp4",
      fileSize: msg.video_note.file_size || null, fileType: "video_note",
      duration: msg.video_note.duration || null, width: null, height: null };
  }
  if (msg.animation) {
    return { fileId: msg.animation.file_id, fileUniqueId: msg.animation.file_unique_id,
      fileName: msg.animation.file_name || "animation.mp4", mimeType: msg.animation.mime_type || "video/mp4",
      fileSize: msg.animation.file_size || null, fileType: "animation",
      duration: msg.animation.duration || null, width: null, height: null };
  }
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    return { fileId: photo.file_id, fileUniqueId: photo.file_unique_id,
      fileName: "photo.jpg", mimeType: "image/jpeg",
      fileSize: photo.file_size || null, fileType: "photo",
      duration: null, width: photo.width || null, height: photo.height || null };
  }
  if (msg.sticker) {
    return { fileId: msg.sticker.file_id, fileUniqueId: msg.sticker.file_unique_id,
      fileName: "sticker.webp", mimeType: "image/webp",
      fileSize: msg.sticker.file_size || null, fileType: "sticker",
      duration: null, width: null, height: null };
  }
  return null;
}

// ── /start ────────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  await upsertUser(ctx);
  const startParam = ctx.startPayload;
  if (startParam) {
    try {
      const rows = await db.select().from(filesTable).where(eq(filesTable.id, startParam)).limit(1);
      if (rows.length > 0) {
        const file = rows[0]!;
        await db.update(filesTable).set({ accessCount: (file.accessCount || 0) + 1 }).where(eq(filesTable.id, startParam));
        const baseUrl = getBaseUrl();
        const streamable = file.isStreamable || isStreamable(file.mimeType);
        const audioFile = file.isAudio || isAudio(file.mimeType);
        const fileLabel = file.fileName || "File";
        let msg = `${getTypeEmoji(file.fileType || "document")} <b>${fileLabel}</b>\n`;
        if (file.mimeType) msg += `🗂 Type: <code>${file.mimeType}</code>\n`;
        if (file.fileSize) msg += `📦 Size: ${formatSize(file.fileSize)}\n`;
        const buttons = buildButtons(baseUrl, file.id, streamable || audioFile);
        await ctx.replyWithHTML(msg, buttons);
        return;
      }
    } catch (err) {
      logger.error({ err }, "Error looking up file from start param");
    }
  }
  await ctx.replyWithHTML(
    `🌐 <b>Welcome to File2Link BOT</b>\n\n` +
    `Forward any file to me and I'll generate:\n` +
    `⬇️ A direct <b>download link</b>\n` +
    `▶️ A <b>stream link</b> for videos and audio\n\n` +
    `📤 <i>Just forward or send any file to get started!</i>`,
  );
});

// ── /pushinfo — Admin pushes content to the stream page ──────────────────────
bot.command("pushinfo", async (ctx) => {
  if (!ADMIN_ID || ctx.from?.id !== ADMIN_ID) {
    await ctx.reply("❌ This command is for admins only.");
    return;
  }

  const msg = ctx.message as any;
  const commandText = (msg.text || msg.caption || "").replace(/^\/pushinfo\s*/, "").trim();
  const replyMsg = msg.reply_to_message;

  // WAY 1 — text push
  if (commandText && !replyMsg) {
    try {
      const id = generateFileId();
      const now = new Date();
      await db.insert(broadcastsTable).values({ id, type: "text", content: commandText, createdAt: now });
      broadcastSse({ id, type: "text", content: commandText, createdAt: now.toISOString() });
      await ctx.reply("✅ Message pushed to the stream page!");
    } catch (err) {
      logger.error({ err }, "/pushinfo: error saving text broadcast");
      await ctx.reply("❌ Failed to push message.");
    }
    return;
  }

  // WAY 2 — media push (admin replies to a media message with /pushinfo)
  if (replyMsg) {
    const meta = extractFileMetadata(replyMsg);
    if (!meta) {
      await ctx.reply("⚠️ The message you replied to has no supported media. Reply to a photo, video, audio, document, etc.");
      return;
    }

    try {
      // Check if this file is already indexed
      const existing = await db.select().from(filesTable).where(eq(filesTable.fileUniqueId, meta.fileUniqueId)).limit(1);
      let recordId: string;

      if (existing.length > 0) {
        // Already in DB — reuse it
        recordId = existing[0]!.id;
        logger.info({ recordId, fileType: meta.fileType }, "/pushinfo: reusing existing file record");
      } else {
        // Fresh file — save it and forward to log channel
        recordId = generateFileId();
        const replyMsgChatId = ctx.chat!.id;
        const replyMsgId     = replyMsg.message_id;

        await db.insert(filesTable).values({
          id: recordId,
          fileId:       meta.fileId,
          fileUniqueId: meta.fileUniqueId,
          fileName:     meta.fileName,
          mimeType:     meta.mimeType,
          fileSize:     meta.fileSize,
          fileType:     meta.fileType,
          chatId:       replyMsgChatId,
          messageId:    replyMsgId,
          duration:     meta.duration,
          width:        meta.width,
          height:       meta.height,
          isStreamable: isStreamable(meta.mimeType) || meta.fileType === "photo",
          isAudio:      isAudio(meta.mimeType),
        });

        const logResult = await logToChannel(
          replyMsgChatId,
          replyMsgId,
          `📢 <b>Stream page push</b>\n🗂 ${meta.fileName || meta.fileType}\n🆔 <code>${recordId}</code>`,
        );
        if (logResult) {
          await db.update(filesTable)
            .set({ chatId: logResult.logChatId, messageId: logResult.logMessageId })
            .where(eq(filesTable.id, recordId));
        }
      }

      // Push to broadcasts table and SSE
      const baseUrl = getBaseUrl();
      const broadcastId = generateFileId();
      const now = new Date();
      const canStream = isStreamable(meta.mimeType) || isAudio(meta.mimeType) || meta.fileType === "photo";

      await db.insert(broadcastsTable).values({
        id: broadcastId,
        type: "file",
        fileId: recordId,
        fileName: meta.fileName || "File",
        mimeType: meta.mimeType,
        fileType: meta.fileType,
        createdAt: now,
      });

      broadcastSse({
        id: broadcastId,
        type: "file",
        fileId: recordId,
        fileName: meta.fileName || "File",
        mimeType: meta.mimeType,
        fileType: meta.fileType,
        canStream,
        streamUrl: `${baseUrl}/api/stream-page/${recordId}`,
        downloadUrl: `${baseUrl}/api/download/${recordId}`,
        createdAt: now.toISOString(),
      });

      await ctx.reply(`✅ File pushed to the stream page!\n🆔 ${recordId}`);

    } catch (err) {
      logger.error({ err }, "/pushinfo: error saving file broadcast");
      await ctx.reply("❌ Failed to push file.");
    }
    return;
  }

  // Neither text nor reply
  await ctx.reply(
    "ℹ️ Usage:\n" +
    "/pushinfo Your announcement text here\n\n" +
    "— or —\n\n" +
    "Reply to a photo/video/file with /pushinfo to push that media to the stream page."
  );
});

// ── /pushclear — Admin removes items from the stream page ────────────────────
bot.command("pushclear", async (ctx) => {
  if (!ADMIN_ID || ctx.from?.id !== ADMIN_ID) {
    await ctx.reply("❌ This command is for admins only.");
    return;
  }

  const userId = ctx.from.id;
  try {
    const items = await db
      .select()
      .from(broadcastsTable)
      .orderBy(desc(broadcastsTable.createdAt))
      .limit(20);

    if (items.length === 0) {
      await ctx.reply("📭 No messages on the stream pages right now.");
      return;
    }

    clearStates.set(userId, { step: "awaitingSelection", items });

    const list = items.map((b, i) => {
      let label = "";
      if (b.type === "file") {
        const kind =
          b.fileType === "photo" ? "🖼 Image" :
          b.fileType === "video" || b.fileType === "animation" || b.fileType === "video_note" ? "🎬 Video" :
          b.fileType === "audio" || b.fileType === "voice" ? "🎵 Audio" :
          "📎 File";
        label = `${kind} — ${b.fileName || "untitled"}`;
      } else {
        const text = (b.content || "").replace(/\n/g, " ").trim();
        label = text.length > 60 ? `${text.slice(0, 60)}…` : (text || "(empty)");
      }
      return `${i + 1}. ${label}`;
    }).join("\n");

    await ctx.reply(
      `📋 Current stream page messages:\n\n${list}\n\n` +
      `Reply with the number(s) to remove (e.g. 1  or  1,3  or  all)\n` +
      `or /cancel to do nothing.`
    );
  } catch (err) {
    logger.error({ err }, "/pushclear: error fetching broadcasts");
    await ctx.reply("❌ Failed to fetch stream page messages.");
  }
});

// ── /cancel ───────────────────────────────────────────────────────────────────
bot.command("cancel", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  if (clearStates.has(userId)) {
    clearStates.delete(userId);
    await ctx.reply("❌ Operation cancelled.");
  } else {
    await ctx.reply("Nothing to cancel.");
  }
});

// ── /goforuser — Admin broadcasts messages to all users via bot DM ────────────
bot.command("goforuser", async (ctx) => {
  if (!ADMIN_ID || ctx.from?.id !== ADMIN_ID) {
    await ctx.reply("❌ You don't have permission to use this command.");
    return;
  }

  try {
    const msg = ctx.message as any;
    const users = await db.select().from(usersTable).where(eq(usersTable.isActive, true));

    if (users.length === 0) {
      await ctx.reply("📭 No active users to broadcast to.");
      return;
    }

    await ctx.reply(`🚀 Starting broadcast to ${users.length} users...`);

    let sentCount    = 0;
    let failedCount  = 0;
    const blockedUsers: string[] = [];
    const commandText = (msg.text || "").replace(/^\/goforuser\s*/, "").trim();

    for (const user of users) {
      try {
        if (commandText) {
          // Plain text broadcast — appears as sent by the bot natively
          await bot.telegram.sendMessage(user.chatId, commandText, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
          });
          sentCount++;
        } else if (msg.reply_to_message) {
          const reply = msg.reply_to_message;
          // Use copyMessage so it appears native (no "Forwarded from" banner)
          await bot.telegram.copyMessage(user.chatId, ctx.chat.id, reply.message_id);
          sentCount++;
        }
        // 10ms delay to stay within Telegram rate limits
        await new Promise(r => setTimeout(r, 10));
      } catch (err: any) {
        failedCount++;
        const errorCode = err?.response?.error_code;
        if (errorCode === 403) {
          blockedUsers.push(`${user.username || user.chatId}`);
          await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, user.id));
        }
        logger.warn({ userId: user.chatId, errorCode, error: err?.message }, "Broadcast failed for user");
      }
    }

    const details = blockedUsers.length > 0
      ? `\n(${blockedUsers.length} users blocked bot, marked inactive)`
      : failedCount > 0
      ? `\n(${failedCount} delivery errors)`
      : "";

    await ctx.reply(
      `✅ Broadcast complete!${details}\n\n` +
      `📤 Sent: ${sentCount}\n❌ Failed: ${failedCount}\n👥 Total: ${users.length}`
    );
    logger.info({ sentCount, failedCount, blockedCount: blockedUsers.length, totalUsers: users.length }, "/goforuser broadcast complete");
  } catch (err) {
    logger.error({ err }, "Error executing /goforuser");
    await ctx.reply("❌ Error during broadcast. Check logs.");
  }
});

// ── Main message handler — files from regular users ───────────────────────────
// Also handles the two-step /pushclear selection reply for admin
bot.on("message", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  await upsertUser(ctx);

  const msg = ctx.message as any;
  const userId = ctx.from?.id;
  if (!userId) return;

  // ── /pushclear two-step: awaiting number selection reply ──────────────────
  const clearState = clearStates.get(userId);
  if (clearState && msg.text && !msg.text.startsWith("/")) {
    clearStates.delete(userId);
    const input = msg.text.trim().toLowerCase();
    const { items } = clearState;
    let toRemove: BroadcastRecord[] = [];

    if (input === "all") {
      toRemove = items;
    } else {
      const nums = input.split(/[\s,]+/).map(Number).filter((n) => !isNaN(n) && n >= 1 && n <= items.length);
      if (nums.length === 0) {
        await ctx.reply("⚠️ Invalid input. Type numbers like 1 or 1,2,3 or all. Use /pushclear to try again.");
        return;
      }
      toRemove = nums.map((n) => items[n - 1]!);
    }

    try {
      const ids = toRemove.map((b) => b.id);
      await db.delete(broadcastsTable).where(inArray(broadcastsTable.id, ids));
      for (const b of toRemove) broadcastSse({ type: "delete", id: b.id });
      const names = toRemove.map((b, i) => {
        if (b.type === "file") {
          const kind =
            b.fileType === "photo" ? "🖼 Image" :
            b.fileType === "video" || b.fileType === "animation" || b.fileType === "video_note" ? "🎬 Video" :
            b.fileType === "audio" || b.fileType === "voice" ? "🎵 Audio" :
            "📎 File";
          return `${i + 1}. ${kind} — ${b.fileName || "untitled"}`;
        }
        const t = (b.content || "").slice(0, 50);
        return `${i + 1}. ${t}${(b.content || "").length > 50 ? "…" : ""}`;
      }).join("\n");
      await ctx.reply(`✅ Removed ${toRemove.length} item(s) from the stream page:\n\n${names}`);
    } catch (err) {
      logger.error({ err }, "/pushclear: delete error");
      await ctx.reply("❌ Failed to remove items.");
    }
    return;
  }

  // ── Regular file handling for normal users ────────────────────────────────
  const meta = extractFileMetadata(msg);
  if (!meta) return; // text messages from users without a pending state are ignored

  const { fileId, fileUniqueId, fileName, mimeType, fileSize, fileType, duration, width, height } = meta;
  const chatId      = ctx.chat.id;
  const messageId   = msg.message_id;
  const fromUserId  = msg.from?.id || null;
  const fromUsername = msg.from?.username || msg.from?.first_name || null;
  const caption     = msg.caption || null;
  const streamable  = isStreamable(mimeType);
  const audioFile   = isAudio(mimeType);
  const imageFile   = (mimeType?.startsWith("image/") ?? false) || fileType === "photo" || fileType === "sticker";

  try {
    const existing = await db.select().from(filesTable).where(eq(filesTable.fileUniqueId, fileUniqueId)).limit(1);
    let recordId: string;

    if (existing.length > 0) {
      recordId = existing[0]!.id;
      await db.update(filesTable).set({ fileId, chatId, messageId }).where(eq(filesTable.id, recordId));
    } else {
      recordId = generateFileId();
      await db.insert(filesTable).values({
        id: recordId, fileId, fileUniqueId, fileName, mimeType, fileSize, fileType,
        fromUserId, fromUsername, chatId, messageId, caption, duration, width, height,
        isStreamable: streamable, isAudio: audioFile,
      });
    }

    const baseUrl       = getBaseUrl();
    const downloadUrl   = `${baseUrl}/api/download/${recordId}`;
    const streamPageUrl = `${baseUrl}/api/stream-page/${recordId}`;
    const typeEmoji     = getTypeEmoji(fileType);
    const canStreamOnline = streamable || audioFile;
    const showOnlineLink  = canStreamOnline || imageFile;
    const onlineLabel     = canStreamOnline ? "▶️ Stream Link" : "🖼 View Link";

    let replyText = `${typeEmoji} <b>${fileName || "File"}</b>\n`;
    if (mimeType)  replyText += `🗂 Type: <code>${mimeType}</code>\n`;
    if (fileSize)  replyText += `📦 Size: ${formatSize(fileSize)}\n`;
    if (duration)  replyText += `⏱ Duration: ${formatDuration(duration)}\n`;
    replyText += `\n⬇️ <b>Download Link</b>\n<code>${downloadUrl}</code>\n`;
    if (showOnlineLink) replyText += `\n${onlineLabel}\n<code>${streamPageUrl}</code>\n`;
    replyText += `\n💡 <i>Tap a link to copy it. For the smoothest playback, open it in an <b>external browser</b> like Chrome, Safari or Firefox.</i> 🚀`;

    const buttons = buildButtons(baseUrl, recordId, canStreamOnline, imageFile);
    await ctx.replyWithHTML(replyText, { reply_parameters: { message_id: messageId }, ...buttons });

    const logMsg =
      `📥 <b>New File Received</b>\n` +
      `👤 From: ${fromUsername ? `@${fromUsername}` : "Unknown"} (${fromUserId})\n` +
      `${typeEmoji} File: ${fileName || "Untitled"}\n` +
      `🗂 Type: ${mimeType || fileType}\n` +
      `📦 Size: ${fileSize ? formatSize(fileSize) : "Unknown"}\n` +
      `🆔 ID: <code>${recordId}</code>\n` +
      `⬇️ <a href="${downloadUrl}">Download</a>` +
      (streamable || audioFile ? `\n▶️ <a href="${streamPageUrl}">Stream Online</a>` :
       imageFile               ? `\n🖼 <a href="${streamPageUrl}">View Online</a>` : "");

    const logResult = await logToChannel(chatId, messageId, logMsg);
    if (logResult) {
      await db.update(filesTable).set({ chatId: logResult.logChatId, messageId: logResult.logMessageId }).where(eq(filesTable.id, recordId));
    }
  } catch (err) {
    logger.error({ err }, "Error processing file message");
    await ctx.reply("❌ An error occurred while processing your file. Please try again.");
  }
});

// ── Utility functions ─────────────────────────────────────────────────────────
function buildButtons(baseUrl: string, recordId: string, canStream: boolean, isImage = false) {
  const downloadUrl   = `${baseUrl}/api/download/${recordId}`;
  const streamPageUrl = `${baseUrl}/api/stream-page/${recordId}`;
  if (canStream) {
    return Markup.inlineKeyboard([[
      Markup.button.url("⬇️ Download", downloadUrl),
      Markup.button.url("▶️ Stream Online", streamPageUrl),
    ]]);
  }
  if (isImage) {
    return Markup.inlineKeyboard([[
      Markup.button.url("⬇️ Download", downloadUrl),
      Markup.button.url("🖼 View Online", streamPageUrl),
    ]]);
  }
  return Markup.inlineKeyboard([[Markup.button.url("⬇️ Download", downloadUrl)]]);
}

function getTypeEmoji(fileType: string): string {
  if (fileType === "video" || fileType === "animation" || fileType === "video_note") return "🎬";
  if (fileType === "audio" || fileType === "voice") return "🎵";
  if (fileType === "photo") return "🖼";
  if (fileType === "sticker") return "🎭";
  return "📄";
}

function formatSize(bytes: number): string {
  if (bytes < 1024)             return `${bytes} B`;
  if (bytes < 1024 * 1024)      return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── Bot startup ───────────────────────────────────────────────────────────────
export function startBot(): void {
  logger.info("Starting Telegram bot...");

  bot.catch((err: any, ctx) => {
    const userId = ctx?.from?.id;
    const chatId = ctx?.chat?.id;
    if (err?.response?.error_code === 403) {
      logger.warn({ userId, chatId, errorCode: 403 }, "Bot blocked by user");
    } else if (err?.code === "ETELEGRAM") {
      logger.error({ userId, chatId, errorCode: err?.response?.error_code, description: err?.response?.description }, "Telegram API error");
    } else {
      logger.error({ err, userId, chatId }, "Error in bot handler");
    }
  });

  bot.launch().catch((err) => logger.error({ err }, "Main bot crashed"));
  logger.info("Telegram bot started");
}
