// orchestrator.js — PLAN → APPROVE → EXECUTE (V1 §6.2, V2 §14).
// The single most important safety property of the engine: nothing consequential
// runs without the owner approving it first. Every task goes through this.

const { LLMRouter } = require("./llm-router");
const { recordUsage } = require("./usage-log");
const costGovernor = require("./cost-governor");
const tasks = require("./tasks");
const { pool } = require("./db");
const { send, sendWithButtons } = require("./telegram");
const github = require("./github");
const { recordEvent } = require("./audit-log");
const { logDecision } = require("./decision-log");
const improvements = require("./improvements");
const missionWorker = require("./mission-worker");
const missions = require("./missions");
const contentMission = require("./content-mission");
const ember = require("./ember");
const intake = require("./intake");
const files = require("./files");

const llm = new LLMRouter();
const { AGENT_NAME } = require("./identity");

// TODO(Season1/Ep5): cross-check against IRREVERSIBLE (V1 §6.2) before auto-anything.
// For Ep 4 every task requires approval; there is no auto-execute path.

async function setPlan(taskId, planMarkdown) {
  await pool.query(
    `UPDATE tasks SET plan = $2, status = 'awaiting_approval', updated_at = now()
     WHERE id = $1`,
    [taskId, { markdown: planMarkdown }]
  );
}

// Phase 1: draft a plan, store it, ask the owner.
async function planTask(taskId) {
  const t = await tasks.getTask(taskId);
  if (!t) throw new Error(`task ${taskId} not found`);

  await tasks.setStatus(taskId, "in_progress"); // briefly, while planning
  const prompt =
    `Task: ${t.title}\n` +
    (t.description ? `Details: ${t.description}\n` : "") +
    `\nDraft a short plan to accomplish this. ` +
    `Use a numbered list (3–6 steps), one line each. ` +
    `No preamble, no closing remarks — just the steps.`;

  await costGovernor.preflight();
  const { text: planMarkdown, provider, usage } = await llm.call(prompt, {
    taskType: "plan",
    system:
      `You are ${AGENT_NAME}, a personal AI operating system. ` +
      `You always draft a plan before doing work, and you wait for explicit ` +
      `approval before executing.`,
  });
  recordUsage("plan", provider, usage);
  await costGovernor.persistCost("plan", provider, usage);

  await setPlan(taskId, planMarkdown);

  const body =
    `📋 *Plan for task #${taskId}*\n` +
    `${t.title}\n\n` +
    `${planMarkdown}\n\n` +
    `Approve to execute, or reject to cancel.`;
  await sendWithButtons(body, [
    [
      { text: "✅ Approve", data: `approve:${taskId}` },
      { text: "❌ Reject", data: `reject:${taskId}` },
    ],
  ]);
}

// Phase 2: owner pressed Approve — execute and store the result.
async function executeApproved(taskId) {
  const t = await tasks.getTask(taskId);
  if (!t) throw new Error(`task ${taskId} not found`);
  if (t.status !== "awaiting_approval") {
    throw new Error(`task ${taskId} not awaiting approval (status: ${t.status})`);
  }

  // Check if this is a mission task — route to mission worker
  if (t.plan && t.plan.missionId) {
    const m = await missions.getMission(t.plan.missionId);
    if (!m) throw new Error(`mission ${t.plan.missionId} not found`);
    await missionWorker.executeMissionTask(taskId, m.plan);
    return;
  }

  await tasks.setStatus(taskId, "approved");
  await tasks.setStatus(taskId, "in_progress");

  const plan = (t.plan && t.plan.markdown) || "(no plan recorded)";
  const prompt =
    `Task: ${t.title}\n\n` +
    `Approved plan:\n${plan}\n\n` +
    `Now produce the deliverable. Be concise and direct. ` +
    `If a step requires real-world action you cannot perform (e.g. making a ` +
    `purchase, sending an email), output a clearly labeled draft instead and ` +
    `say what the human needs to do.`;

  try {
    await costGovernor.preflight();
    const { text: result, provider, usage } = await llm.call(prompt, {
      taskType: "execute",
      system:
        `You are ${AGENT_NAME}. You are executing a plan the owner has just ` +
        `approved. Output only what the owner needs to see.`,
    });
    recordUsage("execute", provider, usage);
    await costGovernor.persistCost("execute", provider, usage);
    await tasks.setStatus(taskId, "done", { result });
    await recordEvent("task_done", { taskId });
    logDecision("task_done", `#${taskId} ${t.title}`);
    await send(`✅ Task #${taskId} done.\n\n${result}`);
  } catch (err) {
    await tasks.setStatus(taskId, "failed", { error: err.message });
    await recordEvent("task_failed", { taskId, error: err.message });
    logDecision("task_failed", `#${taskId} ${err.message}`);
    await send(`❌ Task #${taskId} failed during execute: ${err.message}`);
  }
}

async function rejectTask(taskId) {
  const t = await tasks.getTask(taskId);
  if (!t) throw new Error(`task ${taskId} not found`);
  await tasks.setStatus(taskId, "rejected");
  await recordEvent("task_rejected", { taskId });
  logDecision("task_rejected", `#${taskId} ${t.title}`);
  await send(`🚫 Task #${taskId} rejected. Nothing was executed.`);
}

// Commit tasks: store the commit message + diff summary in `plan`, then route
// on Approve to github.commitAndPush instead of the LLM execute path.
async function proposeCommit({ message, summary }) {
  const t = await tasks.createTask({
    title: `commit: ${message}`,
    description: "github auto-commit (Ep 6)",
  });
  await pool.query(
    `UPDATE tasks SET plan = $2, status = 'awaiting_approval', updated_at = now()
     WHERE id = $1`,
    [t.id, { type: "commit", message, summary }]
  );
  const body =
    `📦 *Proposed commit #${t.id}*\n` +
    `Message: ${message}\n\n` +
    "Changes (--stat):\n" +
    "```\n" +
    summary +
    "\n```\n" +
    `Secret scan: ✅ clean. Approve to push, reject to abort.`;
  await sendWithButtons(body, [
    [
      { text: "✅ Approve & push", data: `approve:${t.id}` },
      { text: "❌ Reject", data: `reject:${t.id}` },
    ],
  ]);
  return t;
}

async function executeApprovedCommit(taskId) {
  const t = await tasks.getTask(taskId);
  if (!t || !t.plan || t.plan.type !== "commit") {
    throw new Error("not a commit task");
  }
  await tasks.setStatus(taskId, "approved");
  await tasks.setStatus(taskId, "in_progress");
  try {
    const r = await github.commitAndPush(t.plan.message);
    if (!r.ok) {
      const reason =
        r.reason === "secrets_found_at_push"
          ? "secret detected at final scan — push aborted"
          : r.reason;
      await tasks.setStatus(taskId, "failed", { error: reason });
      await send(`❌ Commit #${taskId} aborted: ${reason}`);
      return;
    }
    await tasks.setStatus(taskId, "done", {
      result: `pushed ${r.sha} to ${r.branch}`,
    });
    await recordEvent("commit_pushed", { taskId, sha: r.sha, branch: r.branch });
    logDecision("commit_pushed", `#${taskId} ${r.sha.slice(0, 10)} → ${r.branch}`);
    await send(
      `✅ Commit #${taskId} pushed.\nBranch: ${r.branch}\nSHA: ${r.sha.slice(0, 10)}`
    );
  } catch (err) {
    await tasks.setStatus(taskId, "failed", { error: err.message });
    await send(`❌ Commit #${taskId} failed: ${err.message}`);
  }
}

// Telegram callback dispatcher (wired in index.js).
async function handleCallback(cq) {
  const data = cq.data || "";
  const [action, idStr] = data.split(":");
  const id = parseInt(idStr, 10);
  if (!id) return;

  if (action === "reject") {
    // Intake reject: delete the quarantined file so toxic content never lingers.
    const rt = await tasks.getTask(id);
    if (rt && rt.plan && rt.plan.type === "intake") {
      intake.removeQuarantine(rt.plan.quarantinePath);
      await recordEvent("intake_rejected", { id, filename: rt.plan.filename });
    }
    await rejectTask(id);
    return;
  }
  if (action !== "approve") return;

  // Route by task type.
  const t = await tasks.getTask(id);
  if (t && t.plan && t.plan.type === "intake") {
    await executeApprovedIntake(id);
    return;
  }
  if (t && t.plan && t.plan.type === "commit") {
    await send(`⚙️ Approved — pushing #${id}…`);
    await executeApprovedCommit(id);
    return;
  }
  if (t && t.plan && t.plan.type === "improvement") {
    await improvements.fileApprovedImprovement(id);
    return;
  }
  if (t && t.plan && t.plan.type === "content") {
    await send(`⚙️ Approved — filing content #${id}…`);
    await contentMission.executeApprovedContent(id);
    return;
  }
  if (t && t.plan && t.plan.type === "ember") {
    await send(`⚙️ Approved — filing Ember brief #${id}…`);
    await ember.executeApprovedBrief(id);
    return;
  }
  await send(`⚙️ Approved — executing #${id}…`);
  await executeApproved(id);
}

// Approve a quarantined upload: move it from quarantine into its destination.
async function executeApprovedIntake(id) {
  const t = await tasks.getTask(id);
  if (!t || !t.plan || t.plan.type !== "intake") throw new Error("not an intake task");
  const p = t.plan;
  try {
    const buffer = intake.readQuarantine(p.quarantinePath);
    const saved = files.saveUpload(p.dest.root, p.dest.path, p.filename, buffer);
    intake.removeQuarantine(p.quarantinePath);
    await tasks.setStatus(id, "done", { result: `${saved.root}/${saved.dir}/${saved.name}` });
    await recordEvent("intake_approved", { id, filename: p.filename, verdict: p.verdict });
    logDecision("intake_approved", `#${id} ${p.filename} (${p.verdict})`);
    await send(`✅ Approved & ingested: ${p.filename} → ${saved.root}/${saved.dir}/${saved.name}`);
  } catch (err) {
    await tasks.setStatus(id, "failed", { error: err.message });
    await recordEvent("intake_approve_failed", { id, error: err.message });
    await send(`❌ Could not ingest ${p.filename}: ${err.message}`);
  }
}

// Public entrypoint used by /newtask.
async function handleNewTask({ title, description = null }) {
  const t = await tasks.createTask({ title, description });
  await recordEvent("task_created", { taskId: t.id, title });
  logDecision("task_created", `#${t.id} ${title}`);
  try {
    await planTask(t.id);
    await recordEvent("task_planned", { taskId: t.id });
  } catch (err) {
    await tasks.setStatus(t.id, "failed", { error: err.message });
    await recordEvent("task_plan_failed", { taskId: t.id, error: err.message });
    logDecision("task_plan_failed", `#${t.id} ${err.message}`);
    await send(`❌ Task #${t.id} failed during plan: ${err.message}`);
  }
  return t;
}

// Public entrypoint for mission-specific tasks (Ep 10).
async function handleMissionTask({ missionId, title, description = null }) {
  const mission = await missions.getMission(missionId);
  if (!mission) throw new Error(`mission ${missionId} not found`);
  if (mission.status !== "active") throw new Error(`mission ${missionId} is not active`);

  const t = await tasks.createTask({ title, description, missionId });
  await recordEvent("mission_task_created", { taskId: t.id, missionId, title });
  logDecision("mission_task_created", `#${t.id} (${mission.name})`);
  try {
    await missionWorker.planMissionTask(t.id, mission.plan);
    await recordEvent("mission_task_planned", { taskId: t.id });
  } catch (err) {
    await tasks.setStatus(t.id, "failed", { error: err.message });
    await recordEvent("mission_task_plan_failed", { taskId: t.id, error: err.message });
    logDecision("mission_task_plan_failed", `#${t.id} ${err.message}`);
    await send(`❌ Task #${t.id} failed: ${err.message}`);
  }
  return t;
}

module.exports = {
  handleNewTask,
  planTask,
  executeApproved,
  rejectTask,
  handleCallback,
  proposeCommit,
  handleMissionTask,
};
