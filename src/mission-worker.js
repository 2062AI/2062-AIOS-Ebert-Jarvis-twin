// mission-worker.js — mission-specific task planning & execution (Ep 10).
// A mission's worker operates within its canDo/cannotDo constraints.
// The mission's autonomy tier and rules are baked into the system prompt.

const { LLMRouter } = require("./llm-router");
const { recordUsage } = require("./usage-log");
const costGovernor = require("./cost-governor");
const { pool } = require("./db");
const { send, sendWithButtons } = require("./telegram");
const { recordEvent } = require("./audit-log");
const { logDecision } = require("./decision-log");
const tasks = require("./tasks");

const llm = new LLMRouter();
const { AGENT_NAME } = require("./identity");

// Plan a task within a mission's constraints.
async function planMissionTask(taskId, mission) {
  const t = await tasks.getTask(taskId);
  if (!t) throw new Error(`task ${taskId} not found`);

  await tasks.setStatus(taskId, "in_progress");

  const constraints =
    `You are working on a mission: "${mission.name}"\n` +
    `Goal: ${mission.goal}\n` +
    `Autonomy tier: ${mission.autonomy}\n\n` +
    `You may:\n${mission.worker.canDo.map((x) => `  • ${x}`).join("\n")}\n\n` +
    `You may NOT:\n${mission.worker.cannotDo.map((x) => `  • ${x}`).join("\n")}\n\n`;

  const prompt =
    `Task: ${t.title}\n` +
    (t.description ? `Details: ${t.description}\n` : "") +
    `\n${constraints}` +
    `Draft a short plan to accomplish this within the mission boundaries. ` +
    `Use a numbered list (3–6 steps), one line each. ` +
    `No preamble — just the steps.`;

  await costGovernor.preflight();
  const { text: planMarkdown, provider, usage } = await llm.call(prompt, {
    taskType: "mission_plan",
    system:
      `You are ${AGENT_NAME}, operating within a specific mission. ` +
      `You strictly respect the mission's boundaries. ` +
      `You draft a plan before doing work, and wait for approval.`,
    maxTokens: 600,
  });
  recordUsage("mission_plan", provider, usage);
  await costGovernor.persistCost("mission_plan", provider, usage);

  await pool.query(
    `UPDATE tasks SET plan = $2, status = 'awaiting_approval', updated_at = now()
     WHERE id = $1`,
    [taskId, { markdown: planMarkdown, missionId: mission.id }]
  );

  const body =
    `📋 *Mission task #${taskId}*\n` +
    `Mission: ${mission.name}\n` +
    `Task: ${t.title}\n\n` +
    `${planMarkdown}\n\n` +
    `Approve to execute, or reject to cancel.`;
  await sendWithButtons(body, [
    [
      { text: "✅ Approve", data: `approve:${taskId}` },
      { text: "❌ Reject", data: `reject:${taskId}` },
    ],
  ]);
}

// Execute a mission task (owner has approved).
async function executeMissionTask(taskId, mission) {
  const t = await tasks.getTask(taskId);
  if (!t) throw new Error(`task ${taskId} not found`);
  if (t.status !== "awaiting_approval") {
    throw new Error(`task ${taskId} not awaiting approval (status: ${t.status})`);
  }

  await tasks.setStatus(taskId, "approved");
  await tasks.setStatus(taskId, "in_progress");

  const constraints =
    `You are working on a mission: "${mission.name}"\n` +
    `Goal: ${mission.goal}\n\n` +
    `You may:\n${mission.worker.canDo.map((x) => `  • ${x}`).join("\n")}\n\n` +
    `You may NOT:\n${mission.worker.cannotDo.map((x) => `  • ${x}`).join("\n")}\n\n`;

  const plan = (t.plan && t.plan.markdown) || "(no plan recorded)";
  const prompt =
    `Task: ${t.title}\n\n` +
    `${constraints}` +
    `Approved plan:\n${plan}\n\n` +
    `Now produce the deliverable. Be concise and direct. ` +
    `If a step requires action outside your mission scope, say so clearly.`;

  try {
    await costGovernor.preflight();
    const { text: result, provider, usage } = await llm.call(prompt, {
      taskType: "mission_execute",
      system:
        `You are ${AGENT_NAME}, executing a mission task the owner has approved. ` +
        `Output only what the owner needs to see.`,
      maxTokens: 1000,
    });
    recordUsage("mission_execute", provider, usage);
    await costGovernor.persistCost("mission_execute", provider, usage);

    await tasks.setStatus(taskId, "done", { result });
    await recordEvent("mission_task_done", { taskId, missionId: mission.id });
    logDecision("mission_task_done", `#${taskId} (${mission.name})`);

    await send(`✅ Task #${taskId} complete.\n\n${result}`);
  } catch (err) {
    await tasks.setStatus(taskId, "failed", { error: err.message });
    await recordEvent("mission_task_failed", { taskId, missionId: mission.id, error: err.message });
    logDecision("mission_task_failed", `#${taskId} ${err.message}`);
    await send(
      `❌ Task #${taskId} failed: ${err.message}. ` +
        `The mission worker encountered an error and has stopped.`
    );
  }
}

module.exports = { planMissionTask, executeMissionTask };
