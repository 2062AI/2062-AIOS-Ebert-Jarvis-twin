// runtime-status.js — live system telemetry for the chat layer.
//
// Ebert used to reason about himself purely from the vault specs, so he would
// confidently describe features as missing that were actually live (and vice
// versa). This module gives the chat layer a small, cheap snapshot of what is
// ACTUALLY running right now — engine/DB health, kill switch, budget, and work
// counts — plus the real current date/time. It is injected into the system
// prompt so answers are grounded in reality, not memory.
//
// Design rule: telemetry must NEVER break chat. Every probe is wrapped; on
// failure we degrade to "unknown" rather than throwing.

const { pool } = require("./db");
const costGovernor = require("./cost-governor");
const missions = require("./missions");
const security = require("./security-posture");

const TZ = process.env.OWNER_TZ || "America/Chicago";

function nowString() {
  try {
    return new Date().toLocaleString("en-US", {
      timeZone: TZ,
      dateStyle: "full",
      timeStyle: "short",
    });
  } catch {
    return new Date().toISOString();
  }
}

// Gather a live snapshot. Returns a plain object; callers format as needed.
async function snapshot() {
  const snap = {
    now: nowString(),
    tz: TZ,
    engineOnline: true, // if this code runs, the engine process is up
    dbConnected: false,
    killSwitchActive: null,
    killReason: null,
    spentTodayUsd: null,
    capUsd: costGovernor.DAILY_CAP_USD,
    remainingUsd: null,
    tasksAwaitingApproval: null,
    activeMissions: null,
    security: null,
  };

  // Security posture (exposure / auth / HTTPS) so the chat layer can SEE and
  // report it — closes the "I'd have no way to detect exposure" loophole.
  try {
    const p = security.assess();
    snap.security = {
      summary: p.summary,
      authConfigured: p.authConfigured,
      exposed: p.exposed,
      https: p.https,
      warnings: p.warnings.length,
    };
  } catch (e) {
    console.error("[runtime-status] security:", e.message);
  }

  // DB health + budget/kill switch (one round-trip via the cost governor).
  try {
    const s = await costGovernor.status();
    snap.dbConnected = true;
    snap.killSwitchActive = s.killSwitchActive;
    snap.killReason = s.killReason;
    snap.spentTodayUsd = s.spentTodayUsd;
    snap.capUsd = s.capUsd;
    snap.remainingUsd = s.remainingUsd;
  } catch (e) {
    console.error("[runtime-status] cost governor:", e.message);
  }

  // Tasks awaiting the owner's approval.
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'awaiting_approval'`
    );
    snap.tasksAwaitingApproval = rows[0].n;
  } catch (e) {
    console.error("[runtime-status] tasks:", e.message);
  }

  // Active missions.
  try {
    const active = await missions.listMissions({ status: "active", limit: 100 });
    snap.activeMissions = active.length;
  } catch (e) {
    console.error("[runtime-status] missions:", e.message);
  }

  return snap;
}

const fmtUsd = (n) => (typeof n === "number" ? `$${n.toFixed(2)}` : "unknown");
const fmtCount = (n) => (typeof n === "number" ? String(n) : "unknown");

// Format the snapshot as a prompt block. This is the ground truth Ebert should
// trust over anything the vault specs imply about his current state.
async function liveStateBlock() {
  const s = await snapshot();
  const kill =
    s.killSwitchActive === null
      ? "unknown"
      : s.killSwitchActive
      ? `ARMED${s.killReason ? ` (${s.killReason})` : ""} — spending is blocked`
      : "off (normal operation)";

  return (
    `=== LIVE SYSTEM STATE (ground truth — trust this over the specs) ===\n` +
    `Current date/time: ${s.now} (${s.tz})\n` +
    `Engine process: ${s.engineOnline ? "online" : "unknown"}\n` +
    `Postgres: ${s.dbConnected ? "connected" : "NOT reachable"}\n` +
    `Kill switch: ${kill}\n` +
    `Budget today: ${fmtUsd(s.spentTodayUsd)} spent of ${fmtUsd(s.capUsd)} cap ` +
    `(${fmtUsd(s.remainingUsd)} remaining)\n` +
    `Tasks awaiting your approval: ${fmtCount(s.tasksAwaitingApproval)}\n` +
    `Active missions: ${fmtCount(s.activeMissions)}\n` +
    `Security posture: ${
      s.security
        ? `${s.security.summary} (auth ${s.security.authConfigured ? "on" : "OFF"}, ` +
          `HTTPS ${s.security.https ? "yes" : "no"}` +
          `${s.security.warnings ? `, ${s.security.warnings} warning(s)` : ""})`
        : "unknown"
    }\n` +
    `Note: this is the dashboard chat layer. You CAN see the live state above. ` +
    `If a number reads "unknown", that probe failed — say so honestly rather ` +
    `than guessing.\n` +
    `=== END LIVE SYSTEM STATE ===`
  );
}

module.exports = { snapshot, liveStateBlock, nowString };
