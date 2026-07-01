// cost-governor.js — daily budget cap + kill switch (V1 §6.3, rule G).
// Every LLM call must call preflight() first; if it throws, do NOT call the LLM.
// After a successful call, persistCost() records the actual spend.

const { pool } = require("./db");
const { recordEvent } = require("./audit-log");
const { logDecision } = require("./decision-log");

const DAILY_CAP_USD = parseFloat(process.env.DAILY_BUDGET_USD || "5");

// Pricing table mirrors usage-log.js. One source of truth lives here now;
// usage-log.js keeps the vault markdown writer.
const PRICE_PER_1M = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

// Warn ONCE per unpriced model so an unknown model can't silently log $0 and
// bypass the daily budget cap (this is how opus-4-8 slipped through before).
const _warnedModels = new Set();

function estimateCost(model, usage) {
  const p = PRICE_PER_1M[model];
  if (!p && usage && !_warnedModels.has(model)) {
    _warnedModels.add(model);
    console.warn(
      `[cost-governor] No pricing for model "${model}" — its spend logs as $0 ` +
        `and does NOT count toward the daily cap. Add it to PRICE_PER_1M.`
    );
  }
  if (!p || !usage) return 0;
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  // Prompt caching: cache writes bill at 1.25x input, cache reads at 0.1x.
  // Count them so cached calls can't sneak under the daily budget cap.
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  return (
    (inTok / 1e6) * p.input +
    (cacheWrite / 1e6) * p.input * 1.25 +
    (cacheRead / 1e6) * p.input * 0.1 +
    (outTok / 1e6) * p.output
  );
}

// --- kill switch ---------------------------------------------------------

async function getKill() {
  const { rows } = await pool.query(
    `SELECT active, reason, set_at FROM kill_state WHERE id = 1`
  );
  return rows[0] || { active: false, reason: null, set_at: null };
}

async function setKill(active, reason) {
  await pool.query(
    `UPDATE kill_state SET active = $1, reason = $2, set_at = now() WHERE id = 1`,
    [active, reason || null]
  );
  await recordEvent("killswitch_set", { active, reason: reason || null });
  logDecision("killswitch_set", active ? `ARMED (${reason || "?"})` : "DISARMED");
}

// --- budget --------------------------------------------------------------

// Spend today, measured in the OWNER's day (America/Chicago by default), so
// the cap resets at her midnight — not 6–7pm local like the old UTC day did.
const BUDGET_TZ = process.env.BUDGET_TZ || "America/Chicago";

async function spentTodayUsd() {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(est_cost_usd), 0)::float AS total
     FROM usage_log
     WHERE (ts AT TIME ZONE $1) >= date_trunc('day', now() AT TIME ZONE $1)`,
    [BUDGET_TZ]
  );
  return rows[0].total;
}

// Spend so far this calendar month (owner's timezone).
async function spentThisMonthUsd() {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(est_cost_usd), 0)::float AS total
     FROM usage_log
     WHERE (ts AT TIME ZONE $1) >= date_trunc('month', now() AT TIME ZONE $1)`,
    [BUDGET_TZ]
  );
  return rows[0].total;
}

async function status() {
  const kill = await getKill();
  const spent = await spentTodayUsd();
  const month = await spentThisMonthUsd();
  return {
    killSwitchActive: kill.active,
    killReason: kill.reason,
    killSetAt: kill.set_at,
    spentTodayUsd: spent,
    spentThisMonthUsd: month,
    capUsd: DAILY_CAP_USD,
    remainingUsd: Math.max(0, DAILY_CAP_USD - spent),
  };
}

// Must be called and awaited BEFORE any LLM call. Throws to abort.
async function preflight() {
  const kill = await getKill();
  if (kill.active) {
    throw new Error(
      `Kill switch ACTIVE${kill.reason ? ` (${kill.reason})` : ""}. ` +
        `Send /killswitch off to re-enable.`
    );
  }
  const spent = await spentTodayUsd();
  if (spent >= DAILY_CAP_USD) {
    // Trip the kill switch automatically so nothing else can spend until owner acts.
    await setKill(
      true,
      `auto-trip: daily cap $${DAILY_CAP_USD} hit at $${spent.toFixed(4)}`
    );
    throw new Error(
      `Daily budget $${DAILY_CAP_USD} exceeded ($${spent.toFixed(4)} spent). ` +
        `Kill switch tripped automatically.`
    );
  }
}

// Persist actual spend after a successful LLM call.
async function persistCost(tag, model, usage) {
  const cost = estimateCost(model, usage);
  const inTok = (usage && usage.input_tokens) || 0;
  const outTok = (usage && usage.output_tokens) || 0;
  await pool.query(
    `INSERT INTO usage_log (tag, model, input_tokens, output_tokens, est_cost_usd)
     VALUES ($1, $2, $3, $4, $5)`,
    [tag, model, inTok, outTok, cost]
  );
  return cost;
}

module.exports = {
  DAILY_CAP_USD,
  preflight,
  persistCost,
  status,
  getKill,
  setKill,
  estimateCost,
  spentThisMonthUsd,
};
