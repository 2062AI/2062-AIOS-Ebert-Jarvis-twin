// onboarding.js — Episode 1 structured interview (V2 §17).
// Hardcoded question list, no LLM (the LLM router arrives in Episode 2).
// Collects answers over Telegram and writes them to the Config vault.

const { isOnboardingComplete, writeConfigFile, CONFIG_DIR } = require("./vault");
const { AGENT_NAME: DEFAULT_AGENT_NAME } = require("./identity");

// Each step is one question. `info: true` steps are statements the owner
// just acknowledges (any reply advances); their answer text is ignored.
const QUESTIONS = [
  {
    key: "agentName",
    prompt:
      `1/8 — What should I call myself?\n(Press send to accept the default: "${DEFAULT_AGENT_NAME}")`,
  },
  {
    key: "ownerConfirm",
    prompt:
      "2/8 — Quick confirm: you're Eman, timezone America/Chicago (Central)?\nReply 'yes', or type a correction.",
  },
  {
    key: "northStarAddendum",
    prompt:
      "3/8 — My north star is already set: build generational wealth, take care of family, and help others reach health, wealth, freedom, and self-sufficiency.\nAnything you want to add or sharpen? (Reply 'no' to keep it as-is.)",
  },
  {
    key: "tone",
    prompt:
      "4/8 — How should I talk to you? (e.g. direct / warm / playful / terse — your words)",
  },
  {
    key: "workHours",
    prompt:
      "5/8 — When are your working hours? (e.g. '9-5 CT weekdays, weekends sporadic')",
  },
  {
    key: "riskPosture",
    prompt:
      "6/8 — For actions I take on your behalf later, what's your risk posture? (cautious / balanced / aggressive)",
  },
  {
    key: "servicesAck",
    info: true,
    prompt:
      "7/8 — Services wired so far (keys stay in .env, never in the vault):\n• Anthropic (Claude) — brain, first used Ep 2\n• Telegram — this chat\n• GitHub PAT — auto-commit lands Ep 6\n\nReply 'ok' to continue.",
  },
  {
    key: "firstMission",
    prompt:
      "8/8 — Last one. When we reach Season 2, which pursuit should I activate first? Pick a lane or name your own:\n• Wealth / Business\n• Learning / Skills\n• Content / Commerce\n• Home / Health\n• Knowledge / Awareness",
  },
];

const state = { active: false, step: 0, answers: {} };

function begin() {
  state.active = true;
  state.step = 0;
  state.answers = {};
  return QUESTIONS[0].prompt;
}

// Returns the next message to send, and whether the interview just finished.
function record(text) {
  const q = QUESTIONS[state.step];
  const answer = (text || "").trim();

  if (q.key === "agentName" && answer === "") {
    state.answers.agentName = DEFAULT_AGENT_NAME;
  } else if (!q.info) {
    state.answers[q.key] = answer;
  }

  state.step += 1;

  if (state.step < QUESTIONS.length) {
    return { done: false, reply: QUESTIONS[state.step].prompt };
  }

  // Interview complete — write the vault.
  state.active = false;
  writeVault(state.answers);
  return {
    done: true,
    reply:
      `Done. Config vault written to:\n${CONFIG_DIR}\n\n` +
      "Open it in Obsidian/Explorer — you'll see Agent Profile, Goals, " +
      "Preferences, and Connected Services. Episode 1 complete.",
  };
}

function writeVault(a) {
  const stamp = new Date().toISOString();
  const agentName = a.agentName || DEFAULT_AGENT_NAME;

  writeConfigFile(
    "Agent Profile.md",
    `# Agent Profile

- **Name:** ${agentName}
- **Owner:** ${a.ownerConfirm || "Eman"}
- **Timezone:** America/Chicago (Central)
- **Role:** Personal AI Operating System. Orchestrates missions toward the owner's north star.
- **Core constraints:**
  - Plan-first + approval before any consequential action.
  - Secrets live in .env only — never in code, never in this vault.
  - Kill switch + daily budget cap govern all autonomous activity (Ep 5).

_Written by the Episode 1 onboarding interview on ${stamp}._
`
  );

  writeConfigFile(
    "Goals.md",
    `# Goals

## North Star
Build generational wealth, take care of family (children and grandchildren to come), and help others reach health, wealth, freedom, and self-sufficiency.

### Owner's addendum (Episode 1)
${a.northStarAddendum && a.northStarAddendum.toLowerCase() !== "no" ? a.northStarAddendum : "_(none — north star kept as-is)_"}

## First Mission — preflagged for Season 2
${a.firstMission || "_(not specified)_"}

<!-- TODO(Season2/V2 §12): the mission registry turns this preference into a real mission module after your approval. -->
`
  );

  writeConfigFile(
    "Preferences.md",
    `# Preferences

- **Tone / voice:** ${a.tone || "_(not specified)_"}
- **Work hours:** ${a.workHours || "_(not specified)_"}
- **Risk posture (autonomous actions):** ${a.riskPosture || "_(not specified)_"}

<!-- TODO(Season1/Ep4 + Ep5): autonomy tiers (V2 §13) and the budget cap read risk posture from here. -->
`
  );

  // Gitignored per V2 §19 — maps wiring, never keys.
  writeConfigFile(
    "Connected Services.md",
    `# Connected Services

APIs currently wired. **Keys live in .env, never here.**

- **Anthropic (Claude)** — primary LLM / orchestrator brain. Wired Ep 1, first called Ep 2.
- **Telegram Bot API** — owner interface and approvals.
- **GitHub (PAT)** — auto-commit + secrets guard lands Ep 6.

<!-- TODO(Season2+): add OpenAI / Gemini / Ollama, Gmail, etc. as each is wired. -->
`
  );
}

module.exports = { begin, record, state, isOnboardingComplete };
