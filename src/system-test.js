// system-test.js — System Test Standard §9.1 self-test reminder.
//
// The spec makes the agent responsible for system health: it must proactively
// recommend running the full System Test Standard when a trigger is met, with a
// P2 (Important) notification:
//   "System test recommended. Reason: [trigger]. Last full test: [date].
//    Shall I prepare the test?"
// and track the last test date in memory (we use the system_test_state table).
//
// Triggers (§9.2):
//   1. Monthly cadence — the always-on baseline (implemented here via cron).
//   2. Infrastructure additions — call notifyInfraChange() from the relevant code.
//   3. Failure events requiring recovery — call notifyInfraChange() on recovery.
//   4. Core spec uploads — call notifyInfraChange() when such a file is ingested.
//
// All probes are non-throwing: a health-reminder must never crash the engine.

const { pool } = require("./db");
const { send } = require("./telegram");
const { recordEvent } = require("./audit-log");
const { logDecision } = require("./decision-log");

// Monthly cadence. Re-remind cooldown stops daily nagging once a reminder fires;
// it resets as soon as a test is recorded.
const CADENCE_DAYS = parseInt(process.env.SYSTEM_TEST_CADENCE_DAYS || "30", 10);
const REMIND_COOLDOWN_DAYS = parseInt(
  process.env.SYSTEM_TEST_REMIND_COOLDOWN_DAYS || "7",
  10
);

const DAY_MS = 86_400_000;

async function getState() {
  const { rows } = await pool.query(
    `SELECT last_full_test_at, last_reminded_at, last_score, last_band
       FROM system_test_state WHERE id = 1`
  );
  return (
    rows[0] || {
      last_full_test_at: null,
      last_reminded_at: null,
      last_score: null,
      last_band: null,
    }
  );
}

function fmtDate(d) {
  return d ? new Date(d).toISOString().slice(0, 10) : "never";
}

function daysSince(ts) {
  if (!ts) return null;
  return (Date.now() - new Date(ts).getTime()) / DAY_MS;
}

// Record that a full test was run — resets the cadence clock and the reminder.
async function recordTestRun({ score = null, band = null, trigger = "manual" } = {}) {
  await pool.query(
    `UPDATE system_test_state
       SET last_full_test_at = now(), last_reminded_at = NULL,
           last_score = $1, last_band = $2, updated_at = now()
     WHERE id = 1`,
    [score, band]
  );
  await recordEvent("system_test_recorded", { score, band, trigger });
  logDecision("system_test_recorded", `band=${band ?? "?"} score=${score ?? "?"}`);
  return getState();
}

// Is a monthly-cadence reminder due? Returns { due, reason, lastTestStr, state }.
async function evaluate() {
  const state = await getState();
  const lastTestStr = fmtDate(state.last_full_test_at);
  let due = false;
  let reason = null;

  const since = daysSince(state.last_full_test_at);
  if (since === null) {
    due = true;
    reason = "no full System Test has ever been recorded";
  } else if (since >= CADENCE_DAYS) {
    due = true;
    reason = `it has been ${Math.floor(since)} days since the last full test (monthly cadence)`;
  }
  return { due, reason, lastTestStr, state };
}

function p2Message(reason, lastTestStr) {
  return (
    `🔔 P2 — IMPORTANT\n` +
    `System test recommended. Reason: ${reason}. ` +
    `Last full test: ${lastTestStr}. Shall I prepare the test?`
  );
}

// Send the P2 notification, recording it. Used by both the cron path (with
// cooldown) and direct/manual triggers (force).
async function sendReminder(reason, lastTestStr) {
  const msg = p2Message(reason, lastTestStr);
  try {
    await send(msg);
  } catch (e) {
    console.error(`[system-test] reminder send failed: ${e.message}`);
  }
  await pool.query(
    `UPDATE system_test_state SET last_reminded_at = now() WHERE id = 1`
  );
  await recordEvent("system_test_reminder", { reason, lastTest: lastTestStr, priority: "P2" });
  logDecision("system_test_reminder", reason);
  return msg;
}

// Cron entry point. Fires the P2 reminder if a test is due, respecting the
// re-remind cooldown so it doesn't nag every day. `force` bypasses both checks.
async function checkAndRemind({ force = false } = {}) {
  const ev = await evaluate();
  if (!ev.due && !force) {
    return { reminded: false, ...ev };
  }
  if (!force) {
    const sinceRemind = daysSince(ev.state.last_reminded_at);
    if (sinceRemind !== null && sinceRemind < REMIND_COOLDOWN_DAYS) {
      return { reminded: false, suppressed: true, ...ev };
    }
  }
  const reason = ev.reason || "manual check requested";
  const message = await sendReminder(reason, ev.lastTestStr);
  return { reminded: true, message, ...ev };
}

// Trigger #2/#3/#4: an infrastructure change, recovery, or core-spec upload
// happened. Fire an immediate P2 reminder (no cooldown — these are events).
async function notifyInfraChange(reason) {
  const ev = await evaluate();
  const why = `${reason} (infrastructure change — re-test recommended per §9.2)`;
  const message = await sendReminder(why, ev.lastTestStr);
  return { reminded: true, message };
}

module.exports = {
  CADENCE_DAYS,
  REMIND_COOLDOWN_DAYS,
  getState,
  evaluate,
  recordTestRun,
  checkAndRemind,
  notifyInfraChange,
  fmtDate,
  daysSince,
};
