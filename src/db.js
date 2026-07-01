// db.js — Postgres pool + idempotent migrations (Episode 3).
// All persistent state for the engine lives here; the vault stays for
// human-readable memory, this DB is for structured operational state.

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing (set by docker-compose).");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Run on startup. Safe to call repeatedly.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id           SERIAL PRIMARY KEY,
      title        TEXT NOT NULL,
      description  TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      plan         JSONB,
      result       TEXT,
      error        TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Status values used by the engine. See V1 §6.2 operating loop.
  //   pending | planned | awaiting_approval | approved | rejected
  //   | in_progress | done | failed
  await pool.query(`
    CREATE INDEX IF NOT EXISTS tasks_status_created_idx
      ON tasks (status, created_at DESC);
  `);

  // Cost governor (Ep 5, V1 §6.3). Per-call ledger + daily totals come from it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id            BIGSERIAL PRIMARY KEY,
      ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
      tag           TEXT NOT NULL,
      model         TEXT NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      est_cost_usd  NUMERIC(10,6) NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS usage_log_ts_idx ON usage_log (ts DESC);
  `);

  // Kill switch (Ep 5, rule G). Single row, id pinned to 1.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kill_state (
      id      INTEGER PRIMARY KEY DEFAULT 1,
      active  BOOLEAN NOT NULL DEFAULT FALSE,
      reason  TEXT,
      set_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (id = 1)
    );
  `);
  await pool.query(
    `INSERT INTO kill_state (id, active) VALUES (1, FALSE) ON CONFLICT DO NOTHING;`
  );

  // Immutable audit log (Ep 8, V2.1 §21.2). Hash-chained: each row's hash
  // depends on the previous row's hash, so any tampering breaks the chain.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id        BIGSERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
      kind      TEXT NOT NULL,
      payload   JSONB NOT NULL,
      prev_hash TEXT NOT NULL,
      hash      TEXT NOT NULL UNIQUE
    );
  `);

  // Mission registry (Ep 9, V2 §12). Each mission is extensible domain (learn Spanish,
  // run e-commerce, etc.). Drafted by LLM per user interview, approved by owner.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS missions (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      category      TEXT NOT NULL,
      goal          TEXT NOT NULL,
      plan          JSONB NOT NULL,
      status        TEXT NOT NULL DEFAULT 'proposed',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS missions_status_created_idx
      ON missions (status, created_at DESC);
  `);
  // Owner-editable mission progress (milestones, etc.) kept separate from the
  // LLM-drafted `plan` so checking off progress never mutates the spec.
  await pool.query(
    `ALTER TABLE missions ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb;`
  );
  // Per-specialist sub-agent conversations (owner ↔ agent ↔ jarvis collaboration).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id       BIGSERIAL PRIMARY KEY,
      ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
      domain   TEXT NOT NULL,
      role     TEXT NOT NULL,   -- owner | agent | jarvis
      content  TEXT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS agent_messages_domain_idx ON agent_messages (domain, ts);`);

  // Link tasks back to a mission (Phase 2: per-mission task completion counts).
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS mission_id TEXT;`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS tasks_mission_idx ON tasks (mission_id) WHERE mission_id IS NOT NULL;`
  );

  // ---- Season 4 business trackers (revenue, CRM, comms, calendar) ----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS revenue_entries (
      id          BIGSERIAL PRIMARY KEY,
      source      TEXT NOT NULL,                      -- product, service, etc.
      kind        TEXT NOT NULL DEFAULT 'income',     -- income | expense
      amount_usd  NUMERIC(12,2) NOT NULL DEFAULT 0,
      month       TEXT NOT NULL,                       -- YYYY-MM
      note        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      company     TEXT,
      email       TEXT,
      phone       TEXT,
      status      TEXT NOT NULL DEFAULT 'lead',        -- lead | active | past
      note        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS communications (
      id          BIGSERIAL PRIMARY KEY,
      direction   TEXT NOT NULL,                        -- in | out
      channel     TEXT NOT NULL DEFAULT 'email',        -- email | call | dm | other
      party       TEXT,                                 -- who
      subject     TEXT,
      body        TEXT,
      status      TEXT NOT NULL DEFAULT 'logged',       -- draft | sent | received | logged
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id          BIGSERIAL PRIMARY KEY,
      kind        TEXT NOT NULL DEFAULT 'event',        -- event | meeting
      title       TEXT NOT NULL,
      starts_at   TIMESTAMPTZ NOT NULL,
      location    TEXT,
      attendees   TEXT,
      note        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Dashboard chat history — persists the Assistant conversation across refresh.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id        BIGSERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
      role      TEXT NOT NULL,            -- user | assistant
      content   TEXT NOT NULL,
      sources   JSONB
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chat_messages_ts_idx ON chat_messages (ts);
  `);

  // System Test Standard §9.1 — track the last full test so the agent can
  // proactively recommend the monthly test. Single row, id pinned to 1.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_test_state (
      id                INTEGER PRIMARY KEY DEFAULT 1,
      last_full_test_at TIMESTAMPTZ,
      last_reminded_at  TIMESTAMPTZ,
      last_score        INTEGER,
      last_band         TEXT,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (id = 1)
    );
  `);
  await pool.query(
    `INSERT INTO system_test_state (id) VALUES (1) ON CONFLICT DO NOTHING;`
  );

  // Audit log archive — pruned rows land here so the active audit_log stays lean
  // (60-day rolling window) while the full history is preserved for compliance.
  // No hash chain required here; integrity is evidenced by the archive timestamp.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log_archive (
      id         BIGINT NOT NULL,
      ts         TIMESTAMPTZ NOT NULL,
      kind       TEXT NOT NULL,
      payload    JSONB NOT NULL DEFAULT '{}',
      prev_hash  TEXT NOT NULL,
      hash       TEXT NOT NULL,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS audit_archive_ts_idx ON audit_log_archive (ts DESC);`
  );

}

module.exports = { pool, migrate };
