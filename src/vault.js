// vault.js — read/write helpers for the Obsidian vault (V1 §7).
// The vault is the system's long-term memory. Secrets NEVER go here.

const fs = require("fs");
const path = require("path");

const VAULT_PATH = process.env.VAULT_PATH || "/vault";
const CONFIG_DIR = path.join(VAULT_PATH, "Config");

// Onboarding is considered done once the Agent Profile exists.
function isOnboardingComplete() {
  return fs.existsSync(path.join(CONFIG_DIR, "Agent Profile.md"));
}

function writeConfigFile(filename, contents) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, filename), contents, "utf8");
}

module.exports = { VAULT_PATH, CONFIG_DIR, isOnboardingComplete, writeConfigFile };
