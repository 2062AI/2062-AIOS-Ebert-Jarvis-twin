// tasks.js — task store (Episode 3).
// Thin CRUD over the `tasks` table. Plan/approve flow lands in Ep 4;
// execution + budget gating in Ep 5. For now: create, list, get, setStatus.

const { pool } = require("./db");

const VALID_STATUSES = new Set([
  "pending",
  "planned",
  "awaiting_approval",
  "approved",
  "rejected",
  "in_progress",
  "done",
  "failed",
]);

async function createTask({ title, description = null, missionId = null }) {
  const trimmed = (title || "").trim();
  if (!trimmed) throw new Error("title is required");
  const { rows } = await pool.query(
    `INSERT INTO tasks (title, description, mission_id) VALUES ($1, $2, $3) RETURNING *`,
    [trimmed, description, missionId]
  );
  return rows[0];
}

async function listTasks({ limit = 20, status = null } = {}) {
  if (status) {
    const { rows } = await pool.query(
      `SELECT * FROM tasks WHERE status = $1
       ORDER BY created_at DESC LIMIT $2`,
      [status, limit]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT * FROM tasks ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getTask(id) {
  const { rows } = await pool.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function setStatus(id, status, { result = null, error = null } = {}) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`invalid status: ${status}`);
  }
  const { rows } = await pool.query(
    `UPDATE tasks
       SET status = $2, result = COALESCE($3, result),
           error = COALESCE($4, error), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, status, result, error]
  );
  return rows[0] || null;
}

function formatTaskLine(t) {
  const when = new Date(t.created_at).toISOString().slice(0, 16).replace("T", " ");
  return `#${t.id} [${t.status}] ${t.title}  (${when}Z)`;
}

module.exports = {
  createTask,
  listTasks,
  getTask,
  setStatus,
  formatTaskLine,
  VALID_STATUSES,
};
