// improvements.js — engine drafts ONE proposed improvement to itself (Ep 8).
// Per V2 §14, anything the agent BUILDS requires explicit approval. This module
// only produces a textual proposal; approval routes it into the vault.
// It does not modify code on its own.

const fs = require("fs");
const path = require("path");

const { LLMRouter } = require("./llm-router");
const { recordUsage } = require("./usage-log");
const costGovernor = require("./cost-governor");
const { pool } = require("./db");
const tasks = require("./tasks");
const { send, sendWithButtons } = require("./telegram");
const { recordEvent } = require("./audit-log");
const { logDecision } = require("./decision-log");

const llm = new LLMRouter();
const { AGENT_NAME } = require("./identity");
const VAULT_PATH = process.env.VAULT_PATH || "/vault";
const PROPOSALS_FILE = path.join(VAULT_PATH, "Memory", "Proposed Improvements.md");

async function gatherState() {
  const { rows: byStatus } = await pool.query(`
    SELECT status, COUNT(*)::int AS n FROM tasks GROUP BY status
  `);
  const { rows: usage } = await pool.query(`
    SELECT COALESCE(SUM(est_cost_usd),0)::float AS spent,
           COUNT(*)::int AS calls
    FROM usage_log
  `);
  const { rows: audit } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM audit_log`
  );
  const cg = await costGovernor.status();
  return {
    episodesComplete: "Season 1, Episodes 1–7 (engine through cron reports)",
    tasksByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    llmUsage: usage[0],
    auditEvents: audit[0].n,
    dailyCap: cg.capUsd,
    spentToday: cg.spentTodayUsd,
    killActive: cg.killSwitchActive,
  };
}

async function drafImprovement() {
  const state = await gatherState();
  const prompt =
    `You are reviewing your own engine state and proposing ONE concrete ` +
    `improvement to suggest to your owner.\n\n` +
    `Current state:\n` +
    "```json\n" + JSON.stringify(state, null, 2) + "\n```\n\n" +
    `Constraints:\n` +
    `- Pick exactly one improvement.\n` +
    `- It must be small enough to implement in a single short coding session.\n` +
    `- It must not loosen any safety property (approval gate, kill switch, secret guard).\n` +
    `- Prefer improvements that make the next Season's mission work easier.\n\n` +
    `Format your reply exactly:\n` +
    `TITLE: <one-line title>\n` +
    `WHY: <2 sentences>\n` +
    `STEPS:\n1. ...\n2. ...\n3. ...\n` +
    `RISK: <one sentence>\n`;

  await costGovernor.preflight();
  const { text, provider, usage } = await llm.call(prompt, {
    taskType: "improvement",
    system:
      `You are ${AGENT_NAME}. Be specific, short, and concrete. ` +
      `No preamble. Output ONLY the requested format.`,
    maxTokens: 600,
  });
  recordUsage("improvement", provider, usage);
  await costGovernor.persistCost("improvement", provider, usage);
  return text.trim();
}

async function proposeImprovement() {
  const text = await drafImprovement();
  const firstLine = (text.split("\n").find((l) => l.startsWith("TITLE:")) || "TITLE: (untitled)").slice(7).trim();
  const title = firstLine || "Proposed improvement";

  const t = await tasks.createTask({
    title: `improvement: ${title}`,
    description: "engine-proposed improvement (Ep 8)",
  });
  await pool.query(
    `UPDATE tasks SET plan = $2, status = 'awaiting_approval', updated_at = now()
     WHERE id = $1`,
    [t.id, { type: "improvement", title, text }]
  );

  await recordEvent("improvement_proposed", { taskId: t.id, title });
  logDecision("improvement_proposed", `#${t.id} ${title}`);

  const body =
    `💡 *Proposed improvement #${t.id}*\n\n` +
    "```\n" + text + "\n```\n\n" +
    `Approve to record it to vault, reject to discard. ` +
    `(Approval files the proposal — it does NOT auto-execute.)`;
  await sendWithButtons(body, [
    [
      { text: "✅ Approve & file", data: `approve:${t.id}` },
      { text: "❌ Reject", data: `reject:${t.id}` },
    ],
  ]);
  return t;
}

// Called by orchestrator.handleCallback when approve is tapped on an
// improvement-typed task.
async function fileApprovedImprovement(taskId) {
  const t = await tasks.getTask(taskId);
  if (!t || !t.plan || t.plan.type !== "improvement") {
    throw new Error("not an improvement task");
  }
  await tasks.setStatus(taskId, "approved");
  try {
    fs.mkdirSync(path.dirname(PROPOSALS_FILE), { recursive: true });
    if (!fs.existsSync(PROPOSALS_FILE)) {
      fs.writeFileSync(
        PROPOSALS_FILE,
        "# Proposed Improvements\n\nEngine-generated proposals, owner-approved.\n\n",
        "utf8"
      );
    }
    const stamp = new Date().toISOString();
    const block =
      `## ${stamp} — #${taskId}: ${t.plan.title}\n\n` +
      "```\n" + t.plan.text + "\n```\n\n";
    fs.appendFileSync(PROPOSALS_FILE, block, "utf8");
  } catch (err) {
    await tasks.setStatus(taskId, "failed", { error: err.message });
    await recordEvent("improvement_file_failed", { taskId, error: err.message });
    await send(`❌ Could not file improvement #${taskId}: ${err.message}`);
    return;
  }
  await tasks.setStatus(taskId, "done", {
    result: `filed to ${PROPOSALS_FILE}`,
  });
  await recordEvent("improvement_filed", { taskId, title: t.plan.title });
  logDecision("improvement_filed", `#${taskId} ${t.plan.title}`);
  await send(
    `✅ Improvement #${taskId} filed to vault → Memory/Proposed Improvements.md. ` +
      `Nothing was executed; the proposal is yours to act on.`
  );
}

module.exports = { proposeImprovement, fileApprovedImprovement };
