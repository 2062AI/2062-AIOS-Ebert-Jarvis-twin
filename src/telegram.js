// telegram.js — bot init + owner-only message and callback dispatch (V2.1 §21.1).
// Only the owner's chat ID may interact. Everyone else is denied silently.

const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "");

if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing from .env");
if (!OWNER_CHAT_ID) throw new Error("TELEGRAM_CHAT_ID is missing from .env");

const bot = new TelegramBot(TOKEN, { polling: true });

function isOwnerChat(id) {
  return String(id) === OWNER_CHAT_ID;
}

function onOwnerMessage(handler) {
  bot.on("message", (msg) => {
    if (!isOwnerChat(msg.chat.id)) {
      console.warn(`[security] dropped message from non-owner chat ${msg.chat.id}`);
      return;
    }
    handler(msg);
  });
}

// Inline-button callbacks (Approve/Reject etc., Ep 4).
function onOwnerCallback(handler) {
  bot.on("callback_query", async (cq) => {
    const fromChat = cq.message && cq.message.chat && cq.message.chat.id;
    if (!isOwnerChat(fromChat)) {
      console.warn(`[security] dropped callback from non-owner chat ${fromChat}`);
      return;
    }
    try {
      await handler(cq);
    } catch (err) {
      console.error(`[callback] ${err.message}`);
    } finally {
      // Always answer the callback so Telegram clears the spinner.
      bot.answerCallbackQuery(cq.id).catch(() => {});
    }
  });
}

function send(text, opts = {}) {
  return bot.sendMessage(OWNER_CHAT_ID, text, opts);
}

// Convenience for inline keyboards. `rows` is an array of arrays of
// `{ text, data }` objects.
function sendWithButtons(text, rows) {
  const inline_keyboard = rows.map((row) =>
    row.map((b) => ({ text: b.text, callback_data: b.data }))
  );
  return bot.sendMessage(OWNER_CHAT_ID, text, { reply_markup: { inline_keyboard } });
}

function editMessageText(chatId, messageId, text) {
  return bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
}

// Register the slash-menu shown in the Telegram client. Call once at startup.
// `cmds` = [{ command: "ask", description: "Ask the engine" }, ...]
async function setCommandMenu(cmds) {
  try {
    await bot.setMyCommands(cmds);
  } catch (err) {
    console.error(`[telegram] setMyCommands failed: ${err.message}`);
  }
}

// Parse a Telegram message into { cmd, args }.
// Handles: case-insensitive command, leading slash, optional @BotUsername suffix,
// and a trailing args string. Returns { cmd: null } for non-command text.
function parseCommand(text) {
  const raw = (text || "").trim();
  if (!raw.startsWith("/")) return { cmd: null, args: raw };
  const space = raw.indexOf(" ");
  const head = space === -1 ? raw : raw.slice(0, space);
  const args = space === -1 ? "" : raw.slice(space + 1).trim();
  // strip leading "/" and optional "@BotUsername"
  const cmd = head.slice(1).split("@")[0].toLowerCase();
  return { cmd, args };
}

module.exports = {
  bot,
  OWNER_CHAT_ID,
  onOwnerMessage,
  onOwnerCallback,
  send,
  sendWithButtons,
  editMessageText,
  setCommandMenu,
  parseCommand,
};
