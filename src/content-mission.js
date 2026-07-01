// content-mission.js — draft-and-approve content creation (Ep 13).
// Mission-specific handler for the Content mission.
// Drafts social media posts, blog posts, or other content in the owner's voice.
// Always requires approval before publishing to vault.

const fs = require("fs");
const path = require("path");
const { LLMRouter } = require("./llm-router");
const { recordUsage } = require("./usage-log");
const costGovernor = require("./cost-governor");
const { send, sendWithButtons } = require("./telegram");
const { recordEvent } = require("./audit-log");
const { logDecision } = require("./decision-log");
const { pool } = require("./db");

const llm = new LLMRouter();
const { AGENT_NAME } = require("./identity");
const VAULT_PATH = process.env.VAULT_PATH || "/vault";

// Draft content in the owner's voice.
async function draftContent(topic, format = "twitter") {
  const prompt =
    `You are drafting ${format} content about: ${topic}\n\n` +
    `Write 3 options for the owner to choose from. ` +
    `Each should be concise, on-brand, and ready to publish. ` +
    `Number them 1, 2, 3.\n\n` +
    `Format:\n` +
    `1. [first option]\n` +
    `2. [second option]\n` +
    `3. [third option]`;

  const systemPrompt =
    `You are ${AGENT_NAME}. You draft content in the owner's voice: ` +
    `direct, warm, wise, and focused on wealth, family, and helping others. ` +
    `Your tone is conversational but substantive. ` +
    `Output ONLY the numbered options, no preamble.`;

  await costGovernor.preflight();
  const { text, provider, usage } = await llm.call(prompt, {
    taskType: "content",
    system: systemPrompt,
    maxTokens: 600,
  });
  recordUsage("content_draft", provider, usage);
  await costGovernor.persistCost("content_draft", provider, usage);

  return { text: text.trim(), model: provider };
}

// File approved content to the vault.
async function fileApprovedContent(topic, format, content) {
  const contentDir = path.join(VAULT_PATH, "Content");
  try {
    fs.mkdirSync(contentDir, { recursive: true });
    const stamp = new Date().toISOString().split("T")[0];
    const file = path.join(contentDir, `${stamp}-${format}-${topic.slice(0, 20)}.md`);
    const body =
      `# ${format.toUpperCase()}: ${topic}\n\n` +
      `_Drafted: ${new Date().toISOString()}_\n\n` +
      `\`\`\`\n${content}\n\`\`\`\n`;
    fs.writeFileSync(file, body, "utf8");
    return file;
  } catch (err) {
    throw new Error(`Could not file content: ${err.message}`);
  }
}

// Propose content for approval.
async function proposeContent(topic, format = "twitter") {
  const { text: draft, model } = await draftContent(topic, format);

  const taskTitle = `content: ${topic} (${format})`;
  const { rows } = await pool.query(
    `INSERT INTO tasks (title, description, status, plan)
     VALUES ($1, $2, 'awaiting_approval', $3)
     RETURNING id`,
    [
      taskTitle,
      `Draft ${format} content about: ${topic}`,
      JSON.stringify({
        type: "content",
        topic,
        format,
        draft,
        model,
      }),
    ]
  );

  const taskId = rows[0].id;
  await recordEvent("content_proposed", { taskId, topic, format });
  logDecision("content_proposed", `#${taskId} ${topic}`);

  const body =
    `📝 *Proposed content*\n\n` +
    `Topic: ${topic}\n` +
    `Format: ${format}\n` +
    `Model: ${model}\n\n` +
    `${draft}\n\n` +
    `Approve to file to vault, or reject to discard.`;

  await sendWithButtons(body, [
    [
      { text: "✅ Approve & file", data: `approve:${taskId}` },
      { text: "❌ Reject", data: `reject:${taskId}` },
    ],
  ]);

  return taskId;
}

// Execute approved content (file it).
async function executeApprovedContent(taskId) {
  const { rows } = await pool.query(`SELECT plan FROM tasks WHERE id = $1`, [taskId]);
  if (!rows.length) throw new Error(`task ${taskId} not found`);

  const { plan } = rows[0];
  if (!plan || plan.type !== "content") {
    throw new Error("not a content task");
  }

  try {
    const file = await fileApprovedContent(plan.topic, plan.format, plan.draft);
    await pool.query(
      `UPDATE tasks SET status = 'done', result = $1, updated_at = now() WHERE id = $2`,
      [file, taskId]
    );
    await recordEvent("content_filed", { taskId, file });
    logDecision("content_filed", `#${taskId} → ${plan.topic}`);
    await send(`✅ Content #${taskId} filed to vault → Content/${path.basename(file)}`);
  } catch (err) {
    await pool.query(
      `UPDATE tasks SET status = 'failed', error = $1, updated_at = now() WHERE id = $2`,
      [err.message, taskId]
    );
    await recordEvent("content_file_failed", { taskId, error: err.message });
    await send(`❌ Could not file content: ${err.message}`);
  }
}

module.exports = { proposeContent, executeApprovedContent };
