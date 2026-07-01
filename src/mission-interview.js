// mission-interview.js — guided interview to define a new mission (Ep 9).
// Collects: goal, category, autonomy tier, worker rules, tracking metrics.
// Returns structured data for the LLM to draft the mission module.

const CATEGORIES = [
  "Wealth & Business",
  "Learning & Skills",
  "Content & Commerce",
  "Home & Health",
  "Knowledge & Awareness",
];

const AUTONOMY_TIERS = [
  { id: "advisory", label: "Advisory (I decide everything)", description: "Agent proposes; you decide" },
  { id: "drives-with-approval", label: "Drives with approval", description: "Agent acts on pre-approved rules; asks for edge cases" },
  { id: "drives-freely", label: "Drives freely", description: "Agent acts autonomously; reports back" },
];

const QUESTIONS = [
  {
    key: "missionName",
    prompt: `1/6 — What would you like to build or learn? (e.g., "learn Spanish", "run my e-commerce store")`,
  },
  {
    key: "category",
    prompt: `2/6 — Which category?\n${CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n(reply with the number)`,
  },
  {
    key: "goal",
    prompt: `3/6 — What's the concrete goal or outcome? (e.g., "conversational Spanish in 9 months")`,
  },
  {
    key: "autonomyTier",
    prompt: `4/6 — How much autonomy should this mission have?\n${AUTONOMY_TIERS.map((t, i) => `${i + 1}. ${t.label}`).join("\n")}\n(reply with the number)`,
  },
  {
    key: "canDo",
    prompt: `5/6 — What should the agent be allowed to do? (e.g., "assign lessons, track progress, suggest methods")`,
  },
  {
    key: "cannot",
    prompt: `6/6 — What should it NOT do? (e.g., "spend money, contact third parties")`,
  },
];

const state = { active: false, step: 0, answers: {} };

function begin() {
  state.active = true;
  state.step = 0;
  state.answers = {};
  return QUESTIONS[0].prompt;
}

function record(text) {
  const q = QUESTIONS[state.step];
  const answer = (text || "").trim();

  // Validate certain fields
  if (q.key === "category") {
    const idx = parseInt(answer) - 1;
    if (idx >= 0 && idx < CATEGORIES.length) {
      state.answers.category = CATEGORIES[idx];
    } else {
      return { done: false, reply: `Invalid choice. Please reply with a number 1–${CATEGORIES.length}.` };
    }
  } else if (q.key === "autonomyTier") {
    const idx = parseInt(answer) - 1;
    if (idx >= 0 && idx < AUTONOMY_TIERS.length) {
      state.answers.autonomyTier = AUTONOMY_TIERS[idx].id;
    } else {
      return { done: false, reply: `Invalid choice. Please reply with a number 1–${AUTONOMY_TIERS.length}.` };
    }
  } else {
    state.answers[q.key] = answer;
  }

  state.step += 1;

  if (state.step < QUESTIONS.length) {
    return { done: false, reply: QUESTIONS[state.step].prompt };
  }

  // Interview complete
  state.active = false;
  return {
    done: true,
    reply: `✅ Mission interview complete. Drafting module...`,
    answers: state.answers,
  };
}

module.exports = { begin, record, state, CATEGORIES, AUTONOMY_TIERS };
