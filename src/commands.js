// commands.js — single source of truth for the slash-command list.
// Required by index.js (Telegram slash menu) AND web-server.js
// (GET /api/commands → dashboard Commands modal + the "/" chat dropdown).

const COMMAND_MENU = [
  { command: "ask", description: "Ask the engine a question" },
  { command: "newtask", description: "Draft a plan, then approve to execute" },
  { command: "tasks", description: "List recent tasks and their status" },
  { command: "budget", description: "Show today's spend and kill-switch status" },
  { command: "killswitch_on", description: "🔴 Halt all LLM calls immediately" },
  { command: "killswitch_off", description: "🟢 Re-enable LLM calls" },
  { command: "propose_mission", description: "Create a new mission domain" },
  { command: "missions", description: "List your active missions" },
  { command: "lesson", description: "<mission_id> — Request a mission coaching lesson" },
  { command: "delegate", description: "<domain> <task> — Spawn a specialist sub-agent" },
  { command: "content", description: "<topic> — Draft social media content" },
  { command: "youtube", description: "Channel summary / comments <videoId>" },
  { command: "ember", description: "Brand agent: brief / voice / tagline" },
  { command: "skill", description: "List installed skills, or show one" },
  { command: "proofread", description: "<text> — Grammar + clean up any text" },
  { command: "commit", description: "Stage all, scan for secrets, ask to push" },
  { command: "commit_status", description: "Preview what /commit would push" },
  { command: "repo_init", description: "One-time: init local repo + first push" },
  { command: "secrets_test", description: "Self-test the secret guard (no commit)" },
  { command: "brief", description: "Generate the Daily Sovereign Brief now" },
  { command: "report", description: "Run morning or evening report now" },
  { command: "systemtest", description: "System Test status / done / remind now" },
  { command: "backup", description: "Back up the database + vault now" },
  { command: "maintenance", description: "Prune old logs now (auto: Sundays 2:30am)" },
  { command: "audit", description: "Show the last 10 audit-log events" },
  { command: "audit_verify", description: "Verify the audit-log hash chain" },
  { command: "propose_improvement", description: "Engine drafts one improvement" },
  { command: "weekly_review", description: "Batch improvements and missions for approval" },
  { command: "start", description: "Run the first-time setup interview" },
];

module.exports = { COMMAND_MENU };
