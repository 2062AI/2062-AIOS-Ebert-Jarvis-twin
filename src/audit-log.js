// audit-log.js — append-only hash-chained event log (V2.1 §21.2, Episode 8).
// Each row's hash = sha256(prev_hash + "|" + kind + "|" + canonical_payload).
// Editing any past row breaks the chain at that row; verifyChain() detects it.
//
// Concurrency: a single in-memory promise chain serializes appends so two
// simultaneous recordEvent() calls cannot read the same prev_hash.

const crypto = require("crypto");
const { pool } = require("./db");

let tail = Promise.resolve();

function canonical(payload) {
  // Stable JSON: sort object keys recursively. JSONB round-trips are stable
  // but JS Object key order isn't guaranteed across serializers.
  if (payload === null || typeof payload !== "object") return JSON.stringify(payload);
  if (Array.isArray(payload)) return "[" + payload.map(canonical).join(",") + "]";
  const keys = Object.keys(payload).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(payload[k])).join(",") + "}";
}

function chainHash(prevHash, kind, payload) {
  return crypto
    .createHash("sha256")
    .update(prevHash)
    .update("|")
    .update(kind)
    .update("|")
    .update(canonical(payload))
    .digest("hex");
}

async function recordEvent(kind, payload = {}) {
  tail = tail.then(async () => {
    const { rows } = await pool.query(
      `SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`
    );
    const prev = rows[0] ? rows[0].hash : "GENESIS";
    const h = chainHash(prev, kind, payload);
    await pool.query(
      `INSERT INTO audit_log (kind, payload, prev_hash, hash) VALUES ($1,$2,$3,$4)`,
      [kind, payload, prev, h]
    );
    return h;
  });
  // Swallow errors on the tail so one failure doesn't poison subsequent appends.
  return tail.catch((err) => {
    console.error(`[audit] recordEvent failed: ${err.message}`);
    tail = Promise.resolve();
  });
}

async function verifyChain() {
  const { rows } = await pool.query(
    `SELECT id, kind, payload, prev_hash, hash FROM audit_log ORDER BY id ASC`
  );
  if (!rows.length) return { ok: true, count: 0, tail: "GENESIS" };

  // After a prune the oldest surviving row has prev_hash pointing to a deleted
  // row (not "GENESIS"). We anchor from that row's prev_hash so the surviving
  // portion of the chain is still fully verified for internal consistency.
  const pruned = rows[0].prev_hash !== "GENESIS";
  let prev = rows[0].prev_hash;

  for (const r of rows) {
    if (r.prev_hash !== prev) {
      return { ok: false, brokenAt: r.id, reason: "prev_hash mismatch" };
    }
    const expected = chainHash(prev, r.kind, r.payload);
    if (expected !== r.hash) {
      return { ok: false, brokenAt: r.id, reason: "hash mismatch", expected, got: r.hash };
    }
    prev = r.hash;
  }
  return { ok: true, count: rows.length, tail: prev, pruned };
}

// Archive rows older than `days` into audit_log_archive, then delete from
// the active table. The surviving chain remains internally consistent.
async function pruneAuditLog(days = 60) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  // Archive first so nothing is lost.
  const { rowCount: archived } = await pool.query(
    `INSERT INTO audit_log_archive (id, ts, kind, payload, prev_hash, hash)
     SELECT id, ts, kind, payload, prev_hash, hash FROM audit_log WHERE ts < $1`,
    [cutoff]
  );
  const { rowCount: deleted } = await pool.query(
    `DELETE FROM audit_log WHERE ts < $1`, [cutoff]
  );
  return { archived, deleted };
}

async function recentEvents(limit = 10) {
  const { rows } = await pool.query(
    `SELECT id, ts, kind, payload FROM audit_log ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = { recordEvent, verifyChain, recentEvents, chainHash, pruneAuditLog };
