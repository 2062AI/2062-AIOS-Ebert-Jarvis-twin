// scheduler.js — morning + evening reports (V1 §6.4, Episode 7).
// Cron is allowed to run now ONLY because Ep 5 (kill switch + daily cap) is live.
// Reports are pure DB summaries — no LLM calls, no spend, no external I/O
// beyond a Telegram send and a vault write.

const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

const { pool } = require("./db");
const costGovernor = require("./cost-governor");
const { send } = require("./telegram");
const { recordEvent, pruneAuditLog } = require("./audit-log");
const { logDecision } = require("./decision-log");
const { LLMRouter } = require("./llm-router");
const { recordUsage } = require("./usage-log");
const { AGENT_NAME, WRITING_STYLE } = require("./identity");

const llm = new LLMRouter();

const TZ = process.env.REPORTS_TZ || "America/Chicago";
const MORNING_CRON = process.env.MORNING_CRON || "0 4 * * *";
const EVENING_CRON = process.env.EVENING_CRON || "0 20 * * *";
// Nightly backup — 03:00 in REPORTS_TZ.
const BACKUP_CRON = process.env.BACKUP_CRON || "0 3 * * *";
// System Test Standard §9.1 self-test reminder check — daily 09:00. The module's
// own cooldown means it only actually notifies when a test is due (monthly).
const SYSTEM_TEST_CRON = process.env.SYSTEM_TEST_CRON || "0 9 * * *";
// Weekly maintenance — Sundays at 02:30 (between the 03:00 backup and morning brief).
// Prunes audit_log (60d), usage_log (1yr), agent_messages (90d). No LLM calls.
const MAINTENANCE_CRON = process.env.MAINTENANCE_CRON || "30 2 * * 0";
const VAULT_PATH = process.env.VAULT_PATH || "/vault";
const REPORTS_DIR = path.join(VAULT_PATH, "Reports");

function localDateStamp() {
  // YYYY-MM-DD in the report timezone.
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return f.format(new Date());
}

function localTimeStamp() {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return f.format(new Date());
}

async function statsSince(hoursAgo) {
  const { rows: t } = await pool.query(`
    SELECT status, COUNT(*)::int AS n
    FROM tasks
    WHERE updated_at >= now() - ($1 || ' hours')::interval
    GROUP BY status
  `, [hoursAgo]);
  const byStatus = Object.fromEntries(t.map((r) => [r.status, r.n]));

  const { rows: u } = await pool.query(`
    SELECT COALESCE(SUM(est_cost_usd), 0)::float AS spent,
           COALESCE(SUM(input_tokens), 0)::int AS in_tok,
           COALESCE(SUM(output_tokens), 0)::int AS out_tok,
           COUNT(*)::int AS calls
    FROM usage_log
    WHERE ts >= now() - ($1 || ' hours')::interval
  `, [hoursAgo]);
  return { byStatus, usage: u[0] };
}

async function pendingApprovals() {
  const { rows } = await pool.query(`
    SELECT id, title FROM tasks
    WHERE status = 'awaiting_approval'
    ORDER BY created_at ASC LIMIT 10
  `);
  return rows;
}

async function recentDone(limit = 10) {
  const { rows } = await pool.query(`
    SELECT id, title, updated_at FROM tasks
    WHERE status = 'done' AND updated_at >= now() - interval '24 hours'
    ORDER BY updated_at DESC LIMIT $1
  `, [limit]);
  return rows;
}

async function recentFailed(limit = 5) {
  const { rows } = await pool.query(`
    SELECT id, title, error, updated_at FROM tasks
    WHERE status = 'failed' AND updated_at >= now() - interval '24 hours'
    ORDER BY updated_at DESC LIMIT $1
  `, [limit]);
  return rows;
}

function writeVaultReport(stamp, kind, body) {
  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const file = path.join(REPORTS_DIR, `${stamp}-${kind}.md`);
    fs.writeFileSync(file, body, "utf8");
    return file;
  } catch (err) {
    console.error(`[scheduler] vault write failed: ${err.message}`);
    return null;
  }
}

async function buildMorningDataBlock() {
  const stamp = localDateStamp();
  const stats = await statsSince(24);
  const cg = await costGovernor.status();
  const pending = await pendingApprovals();
  const done = await recentDone(5);
  const failed = await recentFailed(3);

  // Active missions count
  let activeMissions = 0;
  try {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM missions WHERE status='active'`);
    activeMissions = rows[0]?.n || 0;
  } catch {}

  // Agent activity in last 24h
  let agentActivity = [];
  try {
    const { rows } = await pool.query(
      `SELECT domain, COUNT(*)::int AS msgs FROM agent_messages
       WHERE ts >= now() - interval '24 hours' GROUP BY domain ORDER BY msgs DESC`
    );
    agentActivity = rows;
  } catch {}

  const taskSummary = Object.entries(stats.byStatus).map(([s, n]) => `${s}:${n}`).join(', ') || 'none';
  const pendingList = pending.map(p => `#${p.id} ${p.title}`).join('; ') || 'none';
  const doneList = done.map(t => t.title).join('; ') || 'none';
  const failedList = failed.map(t => t.title).join('; ') || 'none';
  const agentList = agentActivity.length
    ? agentActivity.map(a => `${a.domain}(${a.msgs}msgs)`).join(', ')
    : 'none active';

  return {
    stamp,
    dataBlock: `DATE: ${stamp} (${TZ})
BUDGET: spent=$${cg.spentTodayUsd.toFixed(4)} of $${cg.capUsd.toFixed(2)} cap, remaining=$${cg.remainingUsd.toFixed(4)}
KILL_SWITCH: ${cg.killSwitchActive ? `ACTIVE (${cg.killReason || "?"})` : "off"}
LLM_CALLS_24H: ${stats.usage.calls} calls, in=${stats.usage.in_tok} out=${stats.usage.out_tok} tokens, $${stats.usage.spent.toFixed(4)}
TASKS: ${taskSummary}
COMPLETED_24H: ${doneList}
FAILED_24H: ${failedList}
AWAITING_APPROVAL: ${pendingList}
ACTIVE_MISSIONS: ${activeMissions}
AGENT_ACTIVITY_24H: ${agentList}`,
  };
}

// Full-detail brief — used by the web dashboard POST /api/brief only.
async function buildMorningReport() {
  const { stamp, dataBlock } = await buildMorningDataBlock();

  const system = `You are ${AGENT_NAME}, the personal AI operating system and sovereign orchestrator for Alex.

You are generating the Daily Sovereign Brief — a concise morning command briefing Alex reads first thing. It must be actionable, honest, and strategic. Use the system data provided.

Generate the brief in this exact structure:

---
[DAILY SOVEREIGN BRIEF]
Date: {date}

## 1. SYSTEM STATUS
Overall Status: (Strong / Stable / Warning)
Top Agent Today: {most active or most relevant — if all idle, say so}
Weakest Agent Today: {what needs attention}

## 2. TODAY'S PRIORITY
Focus: {the single most important thing to work on today}
Why it matters: {one sentence}
Expected outcome: {one sentence}

## 3. KEY ACTIONS (DO THESE)
1. {highest impact action}
2.
3.

## 4. RISKS ⚠️
- Risk 1: {something that could go wrong today — be specific}
- Risk 2:

## 5. OPPORTUNITIES 🚀
- Opportunity 1: {quick win or leverage point available today}
- Opportunity 2:

## 6. AGENT ALERTS
(Only mention agents that need attention today. Skip the rest.)
{list any agent that is overdue, has pending work, or should be activated today}
If no alerts: "All agents nominal."

## 7. QUICK WINS
- Win 1: {something achievable today with fast payoff}
- Win 2:

## 8. WHAT TO AVOID TODAY
- Avoid 1: {specific thing that would waste time or create problems}
- Avoid 2:

## 9. 1 LESSON 🧠
{A single high-impact insight from yesterday's data or the current system state}

## 10. FINAL COMMAND
"Today, focus on ______. Ignore ______. Execute ______."
---

Be direct and brief. Prioritise ruthlessly. Base every point on the actual data — do not invent activity. If yesterday was quiet, acknowledge it and tell Alex what that means for today.

${WRITING_STYLE}`;

  try {
    await costGovernor.preflight();
    const { text, provider, usage } = await llm.call(
      `Generate the Daily Sovereign Brief from this system data:\n\n${dataBlock}`,
      { taskType: "plan", system, maxTokens: 1200 }
    );
    recordUsage("morning_brief", provider, usage);
    await costGovernor.persistCost("morning_brief", provider, usage);
    return `# Daily Sovereign Brief — ${stamp}\n\n${text || "(generation failed)"}`;
  } catch (err) {
    console.error(`[morning] LLM brief failed: ${err.message}`);
    return `# Morning Report — ${stamp}\n\n${dataBlock}`;
  }
}

// Compact Telegram brief — used by the morning cron and /brief Telegram command.
async function buildTelegramBrief() {
  const { stamp, dataBlock } = await buildMorningDataBlock();

  const system = `You are ${AGENT_NAME}. Generate a compact Daily Sovereign Brief for Telegram. Maximum 25 lines. No section numbers. No headers. Use this exact format:

☀️ *Daily Brief — {date}* | {Strong / Stable / Warning}

🎯 *Priority:* {one sentence}

✅ *Do today:*
• {action 1}
• {action 2}
• {action 3}

⚠️ *Risks:*
• {risk 1}
• {risk 2}

🚀 *Quick win:* {one sentence}
🧠 *Lesson:* {one sentence}
🎯 *Command:* "{focus on ___. Execute ___}"

Base every point on the data. No filler.`;

  try {
    await costGovernor.preflight();
    const { text, provider, usage } = await llm.call(
      `Generate the compact brief from:\n\n${dataBlock}`,
      { taskType: "plan", system, maxTokens: 400 }
    );
    recordUsage("morning_brief_tg", provider, usage);
    await costGovernor.persistCost("morning_brief_tg", provider, usage);
    return text || `☀️ *Daily Brief — ${stamp}*\n\n${dataBlock}`;
  } catch (err) {
    console.error(`[morning] Telegram brief failed: ${err.message}`);
    return `☀️ *Daily Brief — ${stamp}*\n\n${dataBlock}`;
  }
}

async function buildEveningReport() {
  const stamp = localDateStamp();
  const stats = await statsSince(24);
  const cg = await costGovernor.status();
  const done = await recentDone(10);
  const failed = await recentFailed(5);
  const pending = await pendingApprovals();

  const lines = [];
  lines.push(`# Evening report — ${stamp} (${TZ})`);
  lines.push("");
  lines.push("**Today's spend**");
  lines.push(`- $${cg.spentTodayUsd.toFixed(4)} of $${cg.capUsd.toFixed(2)} cap (last 24h activity: ${stats.usage.calls} calls)`);
  lines.push(`- Kill switch: ${cg.killSwitchActive ? `ACTIVE (${cg.killReason || "?"})` : "off"}`);
  lines.push("");
  lines.push("**Completed in the last 24h**");
  if (done.length === 0) lines.push("- (none)");
  else for (const t of done) lines.push(`- #${t.id} ${t.title}`);
  lines.push("");
  lines.push("**Failed in the last 24h**");
  if (failed.length === 0) lines.push("- (none)");
  else for (const t of failed) lines.push(`- #${t.id} ${t.title} — ${t.error || "(no error msg)"}`);
  lines.push("");
  lines.push("**Still awaiting approval**");
  if (pending.length === 0) lines.push("- (nothing pending)");
  else for (const p of pending) lines.push(`- #${p.id} ${p.title}`);
  return lines.join("\n");
}

async function runMorning({ silent = false } = {}) {
  const stamp = localDateStamp();
  // Full report → vault; compact version → Telegram (avoids message-too-long errors)
  const [full, tg] = await Promise.all([buildMorningReport(), buildTelegramBrief()]);
  const file = writeVaultReport(stamp, "morning", full);
  await recordEvent("report_generated", { kind: "morning", stamp, file });
  logDecision("report_generated", `morning ${stamp}`);
  if (!silent) {
    await send(tg);
  }
  return { file, body: full };
}

async function runEvening({ silent = false } = {}) {
  const stamp = localDateStamp();
  const body = await buildEveningReport();
  const file = writeVaultReport(stamp, "evening", body);
  await recordEvent("report_generated", { kind: "evening", stamp, file });
  logDecision("report_generated", `evening ${stamp}`);
  if (!silent) {
    await send(`🌙 Evening report (${stamp})\n\n${body}`);
  }
  return { file, body };
}

function startScheduler() {
  if (!cron.validate(MORNING_CRON)) {
    throw new Error(`Invalid MORNING_CRON: ${MORNING_CRON}`);
  }
  if (!cron.validate(EVENING_CRON)) {
    throw new Error(`Invalid EVENING_CRON: ${EVENING_CRON}`);
  }
  cron.schedule(
    MORNING_CRON,
    async () => {
      console.log(`[cron] morning fire at ${localTimeStamp()} ${TZ}`);
      try {
        await runMorning();
      } catch (err) {
        console.error(`[cron] morning failed: ${err.message}`);
        try { await send(`⚠️ Morning report failed: ${err.message}`); } catch {}
      }
    },
    { timezone: TZ }
  );
  cron.schedule(
    EVENING_CRON,
    async () => {
      console.log(`[cron] evening fire at ${localTimeStamp()} ${TZ}`);
      try {
        await runEvening();
      } catch (err) {
        console.error(`[cron] evening failed: ${err.message}`);
        try { await send(`⚠️ Evening report failed: ${err.message}`); } catch {}
      }
    },
    { timezone: TZ }
  );
  if (cron.validate(BACKUP_CRON)) {
    cron.schedule(
      BACKUP_CRON,
      async () => {
        console.log(`[cron] backup fire at ${localTimeStamp()} ${TZ}`);
        try {
          const backup = require("./backup");
          const r = await backup.runBackup();
          await send(`🗄️ Nightly backup done: ${r.db.file} (${Math.round(r.db.bytes / 1024)} KB) + vault snapshot`);
        } catch (err) {
          console.error(`[cron] backup failed: ${err.message}`);
          try { await send(`⚠️ Backup failed: ${err.message}`); } catch {}
        }
      },
      { timezone: TZ }
    );
  }
  if (cron.validate(SYSTEM_TEST_CRON)) {
    cron.schedule(
      SYSTEM_TEST_CRON,
      async () => {
        console.log(`[cron] system-test check fire at ${localTimeStamp()} ${TZ}`);
        try {
          const systemTest = require("./system-test");
          const r = await systemTest.checkAndRemind();
          if (r.reminded) console.log(`[cron] system-test P2 reminder sent: ${r.reason}`);
        } catch (err) {
          console.error(`[cron] system-test check failed: ${err.message}`);
        }
      },
      { timezone: TZ }
    );
  }
  if (cron.validate(MAINTENANCE_CRON)) {
    cron.schedule(
      MAINTENANCE_CRON,
      async () => {
        console.log(`[cron] maintenance fire at ${localTimeStamp()} ${TZ}`);
        try {
          await runMaintenance();
        } catch (err) {
          console.error(`[cron] maintenance failed: ${err.message}`);
        }
      },
      { timezone: TZ }
    );
  }
  console.log(
    `[cron] scheduled: morning="${MORNING_CRON}" evening="${EVENING_CRON}" backup="${BACKUP_CRON}" systemtest="${SYSTEM_TEST_CRON}" maintenance="${MAINTENANCE_CRON}" tz=${TZ}`
  );
}

// Weekly maintenance — prunes stale rows from DB tables. No LLM calls.
// Retention: audit_log=60d, usage_log=1yr, agent_messages=90d.
async function runMaintenance({ silent = false } = {}) {
  const stamp = localDateStamp();
  const results = {};

  // Audit log: 60-day active window; older rows archived to audit_log_archive.
  try {
    results.audit = await pruneAuditLog(60);
    console.log(`[maintenance] audit: archived=${results.audit.archived} deleted=${results.audit.deleted}`);
  } catch (e) { console.error(`[maintenance] audit prune: ${e.message}`); }

  // Usage log: keep 1 year of cost history for spend analysis.
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM usage_log WHERE ts < now() - interval '1 year'`
    );
    results.usageLog = { deleted: rowCount };
    console.log(`[maintenance] usage_log: deleted=${rowCount}`);
  } catch (e) { console.error(`[maintenance] usage_log prune: ${e.message}`); }

  // Agent messages (Ebert + sub-agents): keep 90 days — more than enough for
  // context injection (which only loads last 15 turns anyway).
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM agent_messages WHERE ts < now() - interval '90 days'`
    );
    results.agentMessages = { deleted: rowCount };
    console.log(`[maintenance] agent_messages: deleted=${rowCount}`);
  } catch (e) { console.error(`[maintenance] agent_messages prune: ${e.message}`); }

  await recordEvent("maintenance_run", { stamp, ...results }).catch(() => {});
  logDecision("maintenance_run", `audit pruned ${results.audit?.deleted || 0} rows, usage_log pruned ${results.usageLog?.deleted || 0}, agent_messages pruned ${results.agentMessages?.deleted || 0}`);

  if (!silent) {
    const msg =
      `🧹 Weekly maintenance (${stamp})\n` +
      `• Audit log: ${results.audit?.archived || 0} archived, ${results.audit?.deleted || 0} rows pruned (60d window)\n` +
      `• Usage log: ${results.usageLog?.deleted || 0} rows pruned (>1yr)\n` +
      `• Agent messages: ${results.agentMessages?.deleted || 0} rows pruned (>90d)` +
      (results.agentMessages?.deleted
        ? `\n  ↳ heads-up: that includes Ebert/sub-agent chat history older than 90 days`
        : ``);
    await send(msg).catch(() => {});
  }
  return results;
}

module.exports = {
  startScheduler,
  runMorning,
  runEvening,
  runMaintenance,
  buildMorningReport,
  buildTelegramBrief,
  buildEveningReport,
};
