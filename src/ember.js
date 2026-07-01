// ember.js — Ember, the Chief Brand Officer sub-agent (spec: vault
// References/Specs/Jarvis/Ember Sub-Agent Spec.md, v1.2).
//
// Ember handles brand amplification / PR (public relations, press) for the
// owner's brand portfolio. It DRAFTS and
// RECOMMENDS only — nothing ships publicly without Alex's approval. Every
// output is routed through the inherited Jarvis rails (kill switch, daily budget
// cap, approval gate) and tagged to a brand voice by the F0 guardrail.
//
// Increment 1 (built): F0 voice guardrail, F5 taglines, Monthly Brand Brief.
// Deferred (need external access per the spec's open_items): F2 cohort testing,
// F3 SEO suite, F4 Google Calendar, F8 journalist DB.

const fs = require("fs");
const path = require("path");
const { LLMRouter } = require("./llm-router");
const { recordUsage } = require("./usage-log");
const costGovernor = require("./cost-governor");
const vaultSearch = require("./vault-search");
const { send, sendWithButtons } = require("./telegram");
const { recordEvent } = require("./audit-log");
const { logDecision } = require("./decision-log");
const { pool } = require("./db");
const { AGENT_NAME } = require("./identity");

const llm = new LLMRouter();
const VAULT_PATH = process.env.VAULT_PATH || "/vault";

// SAMPLE brand voices (fictional demo data — replace with your own brands).
// Each voice is a deterministic rule set the F0 guardrail checks content
// against before the owner ever sees it.
const BRANDS = {
  demo_company: {
    label: "Demo Company",
    tone: "Confident, data-driven, risk-aware",
    audience: "Small businesses, professionals",
    do: "Emphasize process and long-term value",
    dont: "Get personal; use hype language",
    example: "Before you scale, audit your foundation.",
  },
  personal_brand: {
    label: "Alex Rivera (personal)",
    tone: "Direct, honest, relatably ambitious",
    audience: "Entrepreneurs, builders, learners",
    do: "Show the work; name the real gap",
    dont: "Oversell; claim expertise not yet earned",
    example: "The gap is speed and knowledge.",
  },
  content_channel: {
    label: "The Channel",
    tone: "Warm, clear, no gatekeeping",
    audience: "Students and lifelong learners",
    do: "Break down complexity; invite participation",
    dont: "Dumb it down; assume prior knowledge",
    example: "AI isn't magic — it's math. Let me show you how.",
  },
};

// Functions that exist in the spec but need access not yet granted.
const BLOCKED = {
  F2: "A/B message testing — needs the test-cohort decision",
  F3: "SEO & content strategy — needs an SEO suite",
  F4: "Calendar-smart scheduling — needs Google Calendar read access",
  F8: "Media relations DB — needs the journalist contact database",
};

function listBrands() {
  return Object.entries(BRANDS).map(([id, b]) => ({ id, label: b.label }));
}

function getVoice(brandId) {
  const b = BRANDS[brandId];
  if (!b) {
    throw new Error(`Unknown brand "${brandId}". Options: ${Object.keys(BRANDS).join(", ")}`);
  }
  return b;
}

// Render the voice rules so the LLM judges against the exact spec definitions.
function voiceRulesText(brandId) {
  const b = getVoice(brandId);
  return (
    `Brand: ${b.label}\n` +
    `- Tone: ${b.tone}\n` +
    `- Audience: ${b.audience}\n` +
    `- Do: ${b.do}\n` +
    `- Don't: ${b.dont}\n` +
    `- On-voice example: "${b.example}"`
  );
}

// Ember's base persona for every call. Grounds it in the mandate + the rule
// that it never ships publicly and never speaks as Alex.
function emberSystem(extra = "") {
  return (
    `You are Ember, the Chief Brand Officer sub-agent of ${AGENT_NAME}, the owner's ` +
    `personal AI operating system. You handle brand amplification and PR (public ` +
    `relations / press) for the owner's brand portfolio. ` +
    `You DRAFT, FLAG, and RECOMMEND only — you never publish, never send, and never ` +
    `speak publicly as Alex. Alex approves everything that ships and is the sole ` +
    `public voice. Be concrete, strategic, and concise.` +
    (extra ? `\n\n${extra}` : "")
  );
}

// Pull Ember's own spec + relevant brand context from the vault (owner audience).
function vaultContextFor(query) {
  try {
    const r = vaultSearch.search(query, { maxChunks: 4 });
    return r.context ? `\n\nRelevant context from the owner's vault:\n${r.context}` : "";
  } catch {
    return "";
  }
}

// --- F0: Voice-Alignment Guardrail (CRITICAL) ----------------------------
// Judge whether a piece of copy fits a brand's voice. Returns the spec's
// PASS / FAIL / FLAG verdict with rationale. This is the keystone gate.
async function checkVoice(text, brandId) {
  if (!text || !text.trim()) throw new Error("Text to check is required");
  getVoice(brandId); // validate

  const system = emberSystem(
    `You are running the F0 Voice-Alignment Guardrail. Judge the copy ONLY against ` +
      `the brand's voice rules below. Verdicts:\n` +
      `[PASS] on-voice — explain briefly why.\n` +
      `[FAIL] off-voice (e.g. hype, oversell, wrong tone) — say what breaks the rule and suggest a fix.\n` +
      `[FLAG] reads like a DIFFERENT one of Ember's brands — name which and suggest reassigning.\n` +
      `Output only the verdict line(s) in that format, no preamble.\n\n` +
      voiceRulesText(brandId)
  );

  await costGovernor.preflight();
  const { text: verdict, provider, usage } = await llm.call(`Copy to judge:\n${text}`, {
    taskType: "ask",
    system,
    maxTokens: 500,
  });
  recordUsage("ember:voice_check", provider, usage);
  await costGovernor.persistCost("ember:voice_check", provider, usage);
  await recordEvent("ember_voice_check", { brand: brandId });
  return { verdict: (verdict || "").trim(), brand: BRANDS[brandId].label, provider };
}

// --- F5: Tagline / messaging drafting ------------------------------------
async function draftTaglines(brandId, context = "") {
  getVoice(brandId);
  const system = emberSystem(
    `Draft tagline / positioning options for the brand below. Produce 3–4 options, ` +
      `each strictly on-voice, then self-check each with a [PASS]/[FAIL]/[FLAG] note ` +
      `per the F0 guardrail. Number the options.\n\n` +
      voiceRulesText(brandId)
  );
  const prompt =
    `Draft taglines for ${BRANDS[brandId].label}.` +
    (context ? ` Focus/context: ${context}` : "") +
    vaultContextFor(`${BRANDS[brandId].label} brand positioning ${context}`);

  await costGovernor.preflight();
  const { text, provider, usage } = await llm.call(prompt, {
    taskType: "ask",
    system,
    maxTokens: 700,
  });
  recordUsage("ember:taglines", provider, usage);
  await costGovernor.persistCost("ember:taglines", provider, usage);
  await recordEvent("ember_taglines", { brand: brandId });
  return { text: (text || "").trim(), brand: BRANDS[brandId].label, provider };
}

// --- Monthly Brand Brief (Week-3 cadence deliverable) --------------------
// Drafts the brief and parks it as an awaiting_approval task. Approval files it
// to the vault (Brand/). Mirrors the content-mission draft-and-approve flow.
async function draftBrandBrief(focus = "") {
  const system = emberSystem(
    `Produce a Monthly Brand Brief for Alex (the spec's Week-3 approval ` +
      `deliverable). Cover, for each brand where relevant:\n` +
      `1. Top 5 publication / interview targets with a one-line angle each.\n` +
      `2. 3 interview/podcast opportunities with a rough likelihood.\n` +
      `3. Tagline / messaging recommendations (tag each to its brand voice).\n` +
      `4. Competitive positioning gaps.\n` +
      `5. SEO / content action items.\n` +
      `End with a short "Decisions needed from Alex" list. Use clear markdown ` +
      `headings. Everything is a DRAFT held for approval — recommend, don't act.`
  );
  const prompt =
    `Draft this month's Brand Brief.` +
    (focus ? ` Special focus this month: ${focus}.` : "") +
    vaultContextFor(`Ember brand strategy clients ${focus}`);

  await costGovernor.preflight();
  const { text, provider, usage } = await llm.call(prompt, {
    taskType: "ask",
    system,
    maxTokens: 2000,
  });
  recordUsage("ember:brand_brief", provider, usage);
  await costGovernor.persistCost("ember:brand_brief", provider, usage);
  return { text: (text || "").trim(), provider };
}

// Propose the brief for approval (creates the task + Telegram buttons).
async function proposeBrandBrief(focus = "") {
  const { text: draft, provider } = await draftBrandBrief(focus);
  const stamp = new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `INSERT INTO tasks (title, description, status, plan)
     VALUES ($1, $2, 'awaiting_approval', $3) RETURNING id`,
    [
      `ember: Monthly Brand Brief ${stamp}`,
      `Ember Monthly Brand Brief${focus ? ` (focus: ${focus})` : ""}`,
      JSON.stringify({ type: "ember", kind: "brand_brief", stamp, focus, draft, model: provider }),
    ]
  );
  const taskId = rows[0].id;
  await recordEvent("ember_brief_proposed", { taskId, stamp, focus });
  logDecision("ember_brief_proposed", `#${taskId} ${stamp}`);

  const body =
    `🔥 *Ember — Monthly Brand Brief* (${stamp})\n\n${draft}\n\n` +
    `Approve to file to the vault (Brand/), or reject to discard.`;
  await sendWithButtons(body, [
    [
      { text: "✅ Approve & file", data: `approve:${taskId}` },
      { text: "❌ Reject", data: `reject:${taskId}` },
    ],
  ]);
  return taskId;
}

// Execute an approved Ember brief — file it to the vault.
async function executeApprovedBrief(taskId) {
  const { rows } = await pool.query(`SELECT plan FROM tasks WHERE id = $1`, [taskId]);
  if (!rows.length) throw new Error(`task ${taskId} not found`);
  const { plan } = rows[0];
  if (!plan || plan.type !== "ember") throw new Error("not an ember task");

  try {
    const dir = path.join(VAULT_PATH, "Brand");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${plan.stamp}-brand-brief.md`);
    const md =
      `---\nclassification: TIER-1-PRIVATE\n---\n\n` +
      `# Monthly Brand Brief — ${plan.stamp}\n\n` +
      `_Drafted by Ember${plan.focus ? ` · focus: ${plan.focus}` : ""} · ${plan.model}_\n\n` +
      `${plan.draft}\n`;
    fs.writeFileSync(file, md, "utf8");
    await pool.query(
      `UPDATE tasks SET status = 'done', result = $1, updated_at = now() WHERE id = $2`,
      [file, taskId]
    );
    await recordEvent("ember_brief_filed", { taskId, file });
    logDecision("ember_brief_filed", `#${taskId} → ${plan.stamp}`);
    await send(`✅ Ember brief #${taskId} filed → Brand/${path.basename(file)}`);
  } catch (err) {
    await pool.query(
      `UPDATE tasks SET status = 'failed', error = $1, updated_at = now() WHERE id = $2`,
      [err.message, taskId]
    );
    await recordEvent("ember_brief_file_failed", { taskId, error: err.message });
    await send(`❌ Could not file Ember brief: ${err.message}`);
  }
}

module.exports = {
  BRANDS,
  BLOCKED,
  listBrands,
  getVoice,
  checkVoice,
  draftTaglines,
  proposeBrandBrief,
  executeApprovedBrief,
};
