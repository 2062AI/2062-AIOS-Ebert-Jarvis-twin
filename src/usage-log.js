// usage-log.js — records token usage for each LLM call (Ep 2).
// LOGGING ONLY. This is NOT the cost governor. Episode 5 adds the daily budget
// cap + kill switch that actually BLOCK calls; this file just writes a record.

const fs = require("fs");
const path = require("path");

const VAULT_PATH = process.env.VAULT_PATH || "/vault";
const LOG_FILE = path.join(VAULT_PATH, "Analytics", "Token & Cost Log.md");

// Pricing table mirrors cost-governor.js — single source of truth.
// Updated by: cost-governor.js PRICE_PER_1M (kept in sync manually).
const PRICE_PER_1M = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

function estimateCost(model, usage) {
  const p = PRICE_PER_1M[model];
  if (!p || !usage) return null;
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  return (inTok / 1e6) * p.input + (outTok / 1e6) * p.output;
}

// Record one call. Returns the estimated cost (or null) for the caller to show.
function recordUsage(tag, model, usage) {
  const stamp = new Date().toISOString();
  const inTok = (usage && usage.input_tokens) || 0;
  const outTok = (usage && usage.output_tokens) || 0;
  const cost = estimateCost(model, usage);
  const costStr = cost === null ? "n/a" : `$${cost.toFixed(5)}`;

  console.log(
    `[usage] ${stamp} ${tag} ${model} in=${inTok} out=${outTok} est=${costStr}`
  );

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (!fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(
        LOG_FILE,
        "# Token & Cost Log\n\nRolled-up LLM usage. Cost is an estimate (logging only — the enforced budget cap arrives in Episode 5).\n\n| Timestamp (UTC) | Tag | Model | Input tok | Output tok | Est. cost |\n| --- | --- | --- | ---: | ---: | ---: |\n",
        "utf8"
      );
    }
    fs.appendFileSync(
      LOG_FILE,
      `| ${stamp} | ${tag} | ${model} | ${inTok} | ${outTok} | ${costStr} |\n`,
      "utf8"
    );
  } catch (err) {
    console.error(`[usage] could not write log: ${err.message}`);
  }

  // TODO(Season1/Ep5 / V1 §6.3): before each call, check withinBudget() against
  // DAILY_BUDGET_USD and block + notify if the cap is blown.
  return cost;
}

module.exports = { recordUsage, estimateCost };
