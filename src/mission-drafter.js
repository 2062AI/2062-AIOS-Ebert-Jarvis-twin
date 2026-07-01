// mission-drafter.js — LLM drafts a mission module from interview answers (Ep 9).
// Takes user input and produces a full mission spec for approval.

const { LLMRouter } = require("./llm-router");
const { recordUsage } = require("./usage-log");
const costGovernor = require("./cost-governor");
const { recordEvent } = require("./audit-log");
const { logDecision } = require("./decision-log");

const llm = new LLMRouter();
const { AGENT_NAME } = require("./identity");

async function draftMission(answers, northStar) {
  const prompt =
    `You are a mission designer. Based on the owner's input, draft a complete mission module.\n\n` +
    `Owner's answers:\n` +
    `- Mission: ${answers.missionName}\n` +
    `- Category: ${answers.category}\n` +
    `- Goal: ${answers.goal}\n` +
    `- Autonomy: ${answers.autonomyTier}\n` +
    `- Can do: ${answers.canDo}\n` +
    `- Cannot do: ${answers.cannot}\n` +
    `- North star: ${northStar}\n\n` +
    `Draft a mission module as a JSON object with this exact structure (no markdown, pure JSON):\n` +
    `{\n` +
    `  "id": "kebab-case-id-from-mission-name",\n` +
    `  "name": "${answers.missionName}",\n` +
    `  "category": "${answers.category}",\n` +
    `  "goal": "${answers.goal}",\n` +
    `  "inheritsNorthStar": true,\n` +
    `  "autonomy": "${answers.autonomyTier}",\n` +
    `  "worker": {\n` +
    `    "canDo": [list of 3-5 concrete actions],\n` +
    `    "cannotDo": [list of boundaries]\n` +
    `  },\n` +
    `  "tracks": [3-5 metrics to measure progress],\n` +
    `  "reportsInto": ["morning brief", "weekly review"],\n` +
    `  "status": "proposed"\n` +
    `}\n\n` +
    `Be specific and concrete. The mission should be actionable.`;

  await costGovernor.preflight();
  const { text, provider, usage } = await llm.call(prompt, {
    taskType: "mission_draft",
    system:
      `You are ${AGENT_NAME}, drafting a new mission module. ` +
      `Output ONLY valid JSON, no preamble or explanation.`,
    maxTokens: 800,
  });
  recordUsage("mission_draft", provider, usage);
  await costGovernor.persistCost("mission_draft", provider, usage);

  // Parse the JSON response
  let module;
  try {
    module = JSON.parse(text.trim());
  } catch (err) {
    throw new Error(`LLM draft was not valid JSON: ${err.message}`);
  }

  // Validate the module has required fields
  const required = ["id", "name", "category", "goal", "autonomy", "worker", "tracks"];
  for (const field of required) {
    if (!(field in module)) {
      throw new Error(`Draft missing required field: ${field}`);
    }
  }

  return module;
}

async function proposeMission(answers, northStar) {
  const module = await draftMission(answers, northStar);
  const missionId = module.id;

  // Log the proposal event
  await recordEvent("mission_proposed", { id: missionId, name: module.name, category: module.category });
  logDecision("mission_proposed", `${module.name} (${module.category})`);

  return { id: missionId, module };
}

module.exports = { draftMission, proposeMission };
