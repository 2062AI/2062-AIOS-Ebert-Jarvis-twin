// missions.js — mission registry CRUD (Ep 9, V2 §12).
// Missions are extensible domains: "learn Spanish", "run e-commerce", etc.
// Each mission is drafted by LLM per user interview, then approved/activated.

const { pool } = require("./db");

const VALID_CATEGORIES = [
  "Wealth & Business",
  "Learning & Skills",
  "Content & Commerce",
  "Home & Health",
  "Knowledge & Awareness",
];

const VALID_STATUSES = new Set(["proposed", "approved", "active", "paused", "archived"]);

async function createMission(data) {
  const { id, name, category, goal, plan } = data;
  if (!id || !name || !category || !goal || !plan) {
    throw new Error("Missing required fields: id, name, category, goal, plan");
  }
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`);
  }
  const { rows } = await pool.query(
    `INSERT INTO missions (id, name, category, goal, plan, status)
     VALUES ($1, $2, $3, $4, $5, 'proposed')
     RETURNING *;`,
    [id, name, category, goal, JSON.stringify(plan)]
  );
  return rows[0] && { ...rows[0], plan: rows[0].plan };
}

async function getMission(id) {
  const { rows } = await pool.query(`SELECT * FROM missions WHERE id = $1;`, [id]);
  return rows[0] && { ...rows[0], plan: rows[0].plan };
}

async function listMissions({ status = null, limit = 10 } = {}) {
  let query = `SELECT * FROM missions`;
  const params = [];
  if (status) {
    query += ` WHERE status = $1`;
    params.push(status);
  }
  query += ` ORDER BY created_at DESC LIMIT ${limit}`;
  const { rows } = await pool.query(query, params);
  return rows.map((r) => ({ ...r, plan: r.plan }));
}

async function setStatus(id, newStatus, updates = {}) {
  if (!VALID_STATUSES.has(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}`);
  }
  const { rows } = await pool.query(
    `UPDATE missions
     SET status = $1, updated_at = now()
     WHERE id = $2
     RETURNING *;`,
    [newStatus, id]
  );
  if (!rows[0]) throw new Error(`Mission not found: ${id}`);
  return { ...rows[0], plan: rows[0].plan };
}

function formatMissionLine(m) {
  return `#${m.id} [${m.status}] ${m.name} — ${m.category}`;
}

// --- Mission detail: descriptions, links, milestones, progress -------------

// Auto-seeded milestone sets per known mission (fully editable afterward).
const DEFAULT_MILESTONES = {
  "youtube-brownai": ["Connect channel (API key)", "Content calendar drafted", "10 videos published", "Reach 1K subs", "Reach 5K subs", "Reach 10K subs"],
  "ai-courses": ["Curriculum outlined", "Course 0 built", "Landing page live", "First sale", "25 students", "50 students"],
  "sharp-crm": ["Feature spec drafted", "MVP deployable", "First deployment", "White-label plan"],
  "ai-engineer": ["Daily cadence set", "Python fundamentals", "SQL fundamentals", "First mini-project", "AI/ML basics"],
};
const GENERIC_MILESTONES = ["Mission defined", "Plan drafted", "In progress", "Goal reached"];

// Per-mission deep links into related dashboard tabs.
const MISSION_LINKS = {
  "youtube-brownai": [["YouTube", "youtube"], ["Revenue", "revenue"], ["Brand (Ember)", "ember"]],
  "ai-courses": [["Revenue", "revenue"], ["Customers", "customers"], ["Brand (Ember)", "ember"]],
  "sharp-crm": [["Customers", "customers"], ["Revenue", "revenue"]],
  "ai-engineer": [["Knowledge", "knowledge"]],
};
const CATEGORY_LINKS = {
  "Content & Commerce": [["Revenue", "revenue"], ["Brand (Ember)", "ember"]],
  "Wealth & Business": [["Revenue", "revenue"], ["Customers", "customers"]],
  "Learning & Skills": [["Knowledge", "knowledge"]],
  "Home & Health": [["Calendar", "calendar"]],
  "Knowledge & Awareness": [["Knowledge", "knowledge"]],
};

function linksFor(m) {
  const raw = MISSION_LINKS[m.id] || CATEGORY_LINKS[m.category] || [];
  return raw.map(([label, tab]) => ({ label, tab }));
}

// A fuller description than `goal`, drawn from the existing LLM plan.
function describe(m) {
  const can = (m.plan && m.plan.worker && m.plan.worker.canDo) || [];
  const cannot = (m.plan && m.plan.worker && m.plan.worker.cannotDo) || [];
  return { goal: m.goal || "", canDo: can, cannotDo: cannot };
}

// Materialize a mission's milestones: stored progress if present, else defaults.
function milestonesOf(m) {
  const stored = m.progress && Array.isArray(m.progress.milestones) ? m.progress.milestones : null;
  if (stored && stored.length) return stored;
  const labels = DEFAULT_MILESTONES[m.id] || GENERIC_MILESTONES;
  return labels.map((label, i) => ({ id: `d${i}`, label, done: false }));
}

function percentComplete(milestones) {
  if (!milestones.length) return 0;
  const done = milestones.filter((x) => x.done).length;
  return Math.round((done / milestones.length) * 100);
}

// Persist a milestone change (toggle/add/delete). Materializes defaults first
// so the owner's edits are saved even on a never-touched mission.
async function updateMilestone(missionId, { action, milestoneId, label, done }) {
  const m = await getMission(missionId);
  if (!m) throw new Error(`Mission not found: ${missionId}`);
  let list = milestonesOf(m).map((x) => ({ ...x }));

  if (action === "add") {
    if (!label || !label.trim()) throw new Error("label is required");
    list.push({ id: `a${Date.now().toString(36)}`, label: label.trim(), done: false });
  } else if (action === "delete") {
    list = list.filter((x) => x.id !== milestoneId);
  } else {
    // toggle / set
    const t = list.find((x) => x.id === milestoneId);
    if (!t) throw new Error(`Milestone not found: ${milestoneId}`);
    t.done = typeof done === "boolean" ? done : !t.done;
  }

  const progress = { ...(m.progress || {}), milestones: list };
  await pool.query(`UPDATE missions SET progress = $1, updated_at = now() WHERE id = $2`, [
    JSON.stringify(progress),
    missionId,
  ]);
  return { milestones: list, percentComplete: percentComplete(list) };
}

// Phase 2 signal: completed vs total tasks linked to this mission.
async function taskStats(missionId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'done')::int AS done
     FROM tasks WHERE mission_id = $1`,
    [missionId]
  );
  return { done: rows[0].done, total: rows[0].total };
}

// Full mission view for the dashboard: spec + description + links + progress.
async function listMissionsDetailed({ limit = 50 } = {}) {
  const all = await listMissions({ limit });
  const out = [];
  for (const m of all) {
    const milestones = milestonesOf(m);
    out.push({
      id: m.id,
      name: m.name,
      category: m.category,
      status: m.status,
      ...describe(m),
      links: linksFor(m),
      milestones,
      percentComplete: percentComplete(milestones),
      tasks: await taskStats(m.id),
    });
  }
  return out;
}

module.exports = {
  createMission,
  getMission,
  listMissions,
  setStatus,
  formatMissionLine,
  VALID_CATEGORIES,
  VALID_STATUSES,
  // detail / progress
  linksFor,
  describe,
  milestonesOf,
  percentComplete,
  updateMilestone,
  taskStats,
  listMissionsDetailed,
};
