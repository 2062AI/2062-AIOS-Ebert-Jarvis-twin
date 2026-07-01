// decision-log.js — human-readable trail of agent decisions (V1 §6.6, Ep 8).
// Appends a markdown bullet to Memory/Decision Log.md. Failures are logged
// but never propagated: a stuck disk should not block a task.

const fs = require("fs");
const path = require("path");

const VAULT_PATH = process.env.VAULT_PATH || "/vault";
const LOG_FILE = path.join(VAULT_PATH, "Memory", "Decision Log.md");

function ensureHeader() {
  if (fs.existsSync(LOG_FILE)) return;
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(
    LOG_FILE,
    "# Decision Log\n\nAppend-only record of agent decisions and key state changes.\n\n",
    "utf8"
  );
}

function logDecision(tag, message, details = null) {
  try {
    ensureHeader();
    const ts = new Date().toISOString();
    let line = `- \`${ts}\` **${tag}** — ${message}`;
    if (details && Object.keys(details).length) {
      line += " " + JSON.stringify(details);
    }
    fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch (err) {
    console.error(`[decision-log] ${err.message}`);
  }
}

module.exports = { logDecision };
