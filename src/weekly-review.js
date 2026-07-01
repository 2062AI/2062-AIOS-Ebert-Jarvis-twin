// weekly-review.js — Sovereign Weekly Intelligence Report (Ep 14, upgraded).
// Runs weekly to produce a structured LLM-generated brief covering all 10 agents,
// system health, key insights, opportunities, and a final directive from Jarvis.

const { pool } = require("./db");
const { send } = require("./telegram");
const { recordEvent } = require("./audit-log");
const { logDecision } = require("./decision-log");
const { LLMRouter } = require("./llm-router");
const { recordUsage } = require("./usage-log");
const costGovernor = require("./cost-governor");
const { AGENT_NAME, WRITING_STYLE } = require("./identity");

const llm = new LLMRouter();

// --- Data gathering -------------------------------------------------------

async function gatherWeeklyData() {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const { rows: improvements } = await pool.query(
    `SELECT id, title, plan FROM tasks
     WHERE title LIKE 'improvement:%' AND status IN ('proposed','awaiting_approval')
     AND created_at >= $1 ORDER BY created_at DESC`,
    [oneWeekAgo]
  );

  const { rows: missions } = await pool.query(
    `SELECT id, name, category, status FROM missions
     WHERE status = 'active' ORDER BY created_at DESC`,
  );

  const { rows: completed } = await pool.query(
    `SELECT id, title, updated_at FROM tasks
     WHERE status = 'done' AND updated_at >= $1
     ORDER BY updated_at DESC LIMIT 10`,
    [oneWeekAgo]
  );

  const { rows: failed } = await pool.query(
    `SELECT id, title, updated_at FROM tasks
     WHERE status = 'failed' AND updated_at >= $1
     ORDER BY updated_at DESC LIMIT 5`,
    [oneWeekAgo]
  );

  const { rows: pending } = await pool.query(
    `SELECT id, title FROM tasks WHERE status = 'awaiting_approval'
     ORDER BY created_at ASC LIMIT 10`
  );

  const { rows: usage } = await pool.query(
    `SELECT COALESCE(SUM(est_cost_usd),0)::float AS spent,
            COUNT(*)::int AS calls,
            COALESCE(SUM(input_tokens),0)::int AS in_tokens,
            COALESCE(SUM(output_tokens),0)::int AS out_tokens
     FROM usage_log WHERE ts >= $1`,
    [oneWeekAgo]
  );

  // Per-agent activity (messages in sub-agent chats this week)
  const { rows: agentActivity } = await pool.query(
    `SELECT domain, COUNT(*)::int AS messages
     FROM agent_messages WHERE ts >= $1
     GROUP BY domain ORDER BY messages DESC`,
    [oneWeekAgo]
  );

  // Per-agent LLM spend this week
  const { rows: agentCosts } = await pool.query(
    `SELECT tag, COALESCE(SUM(est_cost_usd),0)::float AS cost, COUNT(*)::int AS calls
     FROM usage_log WHERE tag LIKE 'subagent:%' AND ts >= $1
     GROUP BY tag`,
    [oneWeekAgo]
  );

  // Audit events for sub-agent spawns this week
  const { rows: agentSpawns } = await pool.query(
    `SELECT payload->>'domain' AS domain, COUNT(*)::int AS spawns
     FROM audit_log WHERE kind = 'subagent_spawned' AND ts >= $1
     GROUP BY payload->>'domain'`,
    [oneWeekAgo]
  );

  return {
    improvements, missions, completed, failed, pending,
    usage: usage[0],
    agentActivity,
    agentCosts,
    agentSpawns,
    weekStart: oneWeekAgo.toISOString().slice(0, 10),
    weekEnd: new Date().toISOString().slice(0, 10),
  };
}

// Short Telegram summary — no LLM call, always works, fits in one message.
function buildWeeklyTelegramSummary(data) {
  const ALL_AGENTS = ['empire','closer','treasury','amplify','oracle','forge','sensei','lifestyle','sentinel','harvest'];
  const activityMap = Object.fromEntries(data.agentActivity.map(r => [r.domain, r.messages]));
  const activeAgents = ALL_AGENTS.filter(id => activityMap[id] > 0);
  const idleAgents   = ALL_AGENTS.filter(id => !activityMap[id]);

  const lines = [
    `📊 *Weekly Intel — ${data.weekStart} → ${data.weekEnd}*`,
    ``,
    `💰 Spend: $${data.usage.spent.toFixed(4)} · ${data.usage.calls} LLM calls`,
    `✅ Done: ${data.completed.length} tasks  ❌ Failed: ${data.failed.length}`,
  ];
  if (data.pending.length)  lines.push(`⏳ Awaiting approval: ${data.pending.length}`);
  if (data.missions.length) lines.push(`🎯 Active missions: ${data.missions.length}`);
  lines.push(``);
  lines.push(`🤖 Active agents (${activeAgents.length}/10): ${activeAgents.length ? activeAgents.join(', ') : 'none'}`);
  if (idleAgents.length)    lines.push(`💤 Idle: ${idleAgents.join(', ')}`);
  lines.push(``);
  if (data.completed.length) {
    lines.push(`✅ *Top wins:*`);
    data.completed.slice(0, 3).forEach(t => lines.push(`• ${t.title}`));
  }
  if (data.failed.length) {
    lines.push(`❌ *Failed:*`);
    data.failed.slice(0, 2).forEach(t => lines.push(`• ${t.title}`));
  }
  lines.push(``);
  lines.push(`📋 Full report saved → view in dashboard`);
  return lines.join('\n');
}

function buildDataSummary(data) {
  const activityMap = Object.fromEntries(data.agentActivity.map(r => [r.domain, r.messages]));
  const spawnMap = Object.fromEntries(data.agentSpawns.map(r => [r.domain, r.spawns]));
  const costMap = Object.fromEntries(
    data.agentCosts.map(r => [r.tag.replace('subagent:', ''), { cost: r.cost, calls: r.calls }])
  );

  const ALL_AGENTS = ['empire','closer','treasury','amplify','oracle','forge','sensei','lifestyle','sentinel','harvest'];

  const agentRows = ALL_AGENTS.map(id => {
    const msgs = activityMap[id] || 0;
    const spawns = spawnMap[id] || 0;
    const costInfo = costMap[id] || { cost: 0, calls: 0 };
    const status = (msgs + spawns) > 0 ? 'active' : 'idle';
    return `  ${id}: status=${status}, chat_messages=${msgs}, task_spawns=${spawns}, llm_calls=${costInfo.calls}, spend=$${costInfo.cost.toFixed(4)}`;
  }).join('\n');

  const completedList = data.completed.length
    ? data.completed.map(t => `  - #${t.id} ${t.title}`).join('\n')
    : '  (none)';

  const failedList = data.failed.length
    ? data.failed.map(t => `  - #${t.id} ${t.title}`).join('\n')
    : '  (none)';

  const pendingList = data.pending.length
    ? data.pending.map(t => `  - #${t.id} ${t.title}`).join('\n')
    : '  (none)';

  const missionList = data.missions.length
    ? data.missions.map(m => `  - ${m.name} (${m.category})`).join('\n')
    : '  (none)';

  const improvementList = data.improvements.length
    ? data.improvements.map(i => {
        const title = i.plan?.title || i.title;
        return `  - #${i.id} ${title}`;
      }).join('\n')
    : '  (none)';

  return `
WEEK: ${data.weekStart} to ${data.weekEnd}

SYSTEM METRICS:
  LLM calls: ${data.usage.calls}
  Tokens in/out: ${data.usage.in_tokens} / ${data.usage.out_tokens}
  Total spend: $${data.usage.spent.toFixed(4)}

AGENT ACTIVITY (all 10):
${agentRows}

TASKS COMPLETED (last 7 days):
${completedList}

TASKS FAILED:
${failedList}

AWAITING APPROVAL:
${pendingList}

ACTIVE MISSIONS:
${missionList}

PROPOSED IMPROVEMENTS:
${improvementList}
`.trim();
}

// --- Report generation ----------------------------------------------------

async function proposeWeeklyReview() {
  const data = await gatherWeeklyData();
  const dataSummary = buildDataSummary(data);

  const system = `You are ${AGENT_NAME}, the personal AI operating system and sovereign orchestrator for Alex.

You are generating the Sovereign Weekly Intelligence Report — a structured strategic brief that Alex reads every week to understand how her AI system is performing and what to focus on next.

Your 10 specialist agents are: Empire (Strategist), Closer (Revenue Generator), Treasury (Financial Brain), Amplify (Marketer), Oracle (Researcher), Forge (Builder), Sensei (Trainer), Lifestyle (Life Manager), Sentinel (Protector), Harvest (Sustainability Agent).

You will receive raw system data for the week. Generate the full report in this exact structure:

---
[SOVEREIGN WEEKLY INTELLIGENCE REPORT]
Week: {dates}

## 1. SYSTEM OVERVIEW
Overall System Health: (Strong / Stable / At Risk)
Top Performing Agent: {name — why}
Weakest Agent: {name — why}
Average Activity Score: {low/medium/high, with brief rationale}

## 2. KEY INSIGHTS (MOST IMPORTANT)
- Insight 1: {a durable pattern, not an individual event}
- Insight 2:
- Insight 3:

## 3. CRITICAL ISSUES 🚨
- Issue 1: {what is actively hurting performance — be specific}
- Issue 2:
- Issue 3:
(Write "None this week" if genuinely clear)

## 4. OPPORTUNITIES 💰
- Opportunity 1: {where growth or leverage exists right now}
- Opportunity 2:
- Opportunity 3:

## 5. AGENT BREAKDOWN
(For each agent: one-line status + one-line note. Be honest — idle is idle.)
💼 Empire: Status: {active/idle} | Note: {one line}
💰 Closer: Status: | Note:
📊 Treasury: Status: | Note:
📣 Amplify: Status: | Note:
🔮 Oracle: Status: | Note:
🛠 Forge: Status: | Note:
🧠 Sensei: Status: | Note:
🧘 Lifestyle: Status: | Note:
🛡 Sentinel: Status: | Note:
🌱 Harvest: Status: | Note:

## 6. TRAINING FOCUS (NEXT WEEK)
Primary Focus: {which agent needs development or deployment}
Target Agent:
Why:

## 7. DECISIONS REQUIRED
- Decision 1: {something Alex must decide — be specific}
- Decision 2:
- Decision 3:
(Write "None this week" if nothing is blocked)

## 8. ACTION PLAN
Step 1:
Step 2:
Step 3:
Step 4:
Step 5:

## 9. LESSONS FOR THE OWNER 🧠
- Lesson 1: {what the system data reveals that Alex should internalise}
- Lesson 2:
- Lesson 3:

## 10. PREDICTIONS 🔮
- What will likely improve:
- What may fail:
- What to watch:

## 11. FINAL DIRECTIVE
(Speak as the sovereign orchestrator — direct, clear, one paragraph)
"This week, focus on ____. Avoid ____. The highest-leverage move is ____."
---

Base every section on the actual data provided. Do not invent activity that didn't happen. If agents are idle, say so honestly and explain what that means. Be strategic and direct — this is a command briefing, not a status update.

${WRITING_STYLE}`;

  let report;
  try {
    await costGovernor.preflight();
    const { text, provider, usage } = await llm.call(
      `Generate the Sovereign Weekly Intelligence Report from this system data:\n\n${dataSummary}`,
      { taskType: "plan", system, maxTokens: 2000 }
    );
    recordUsage("weekly_review", provider, usage);
    await costGovernor.persistCost("weekly_review", provider, usage);
    report = text || "(report generation returned no text)";
  } catch (err) {
    // Fail-soft: send the raw data summary if LLM fails
    console.error(`[weekly_review] LLM failed: ${err.message}`);
    report = `📊 Weekly data summary (LLM unavailable):\n\n${dataSummary}`;
  }

  // Write to vault
  const fs = require("fs");
  const path = require("path");
  const VAULT_PATH = process.env.VAULT_PATH || "/vault";
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    const dir = path.join(VAULT_PATH, "Reports");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${stamp}-weekly-intel.md`), report, "utf8");
  } catch (e) {
    console.error(`[weekly_review] vault write failed: ${e.message}`);
  }

  // Send compact summary to Telegram; full report is in vault and dashboard.
  const tgSummary = buildWeeklyTelegramSummary(data);
  await send(tgSummary);
  await recordEvent("weekly_review_generated", {
    tasksCompleted: data.completed.length,
    agentsActive: data.agentActivity.length,
    spend: data.usage.spent,
  });
  logDecision("weekly_review", `week ${data.weekStart}→${data.weekEnd}`);
}

module.exports = { proposeWeeklyReview, gatherWeeklyData };
