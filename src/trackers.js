// trackers.js — Season 4 business trackers: revenue, customers, communications,
// calendar/meetings. Real persistent data (manual entry now; can sync to Gmail/
// Google Calendar later). Each tracker is a thin CRUD wrapper over its table.

const { pool } = require("./db");

// ---- Revenue ----
async function addRevenue({ source, kind = "income", amount_usd = 0, month, note }) {
  if (!source || !month) throw new Error("source and month are required");
  const { rows } = await pool.query(
    `INSERT INTO revenue_entries (source, kind, amount_usd, month, note)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [source, kind, amount_usd, month, note || null]
  );
  return rows[0];
}
async function listRevenue() {
  const { rows } = await pool.query(`SELECT * FROM revenue_entries ORDER BY month DESC, id DESC`);
  return rows;
}
async function deleteRevenue(id) {
  await pool.query(`DELETE FROM revenue_entries WHERE id=$1`, [id]);
}
async function revenueSummary() {
  const rows = await listRevenue();
  let income = 0, expense = 0;
  const bySource = {}, byMonth = {};
  for (const r of rows) {
    const amt = Number(r.amount_usd);
    if (r.kind === "expense") { expense += amt; } else { income += amt; }
    const signed = r.kind === "expense" ? -amt : amt;
    bySource[r.source] = (bySource[r.source] || 0) + signed;
    byMonth[r.month] = (byMonth[r.month] || 0) + signed;
  }
  return {
    rows, income, expense, profit: income - expense,
    bySource, byMonth,
    goalMonthlyMin: 3000, goalMonthlyMax: 5000, // income strategy target
  };
}

// ---- Customers ----
async function addCustomer(d) {
  if (!d.name) throw new Error("name is required");
  const { rows } = await pool.query(
    `INSERT INTO customers (name, company, email, phone, status, note)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [d.name, d.company || null, d.email || null, d.phone || null, d.status || "lead", d.note || null]
  );
  return rows[0];
}
async function listCustomers() {
  const { rows } = await pool.query(`SELECT * FROM customers ORDER BY created_at DESC`);
  return rows;
}
async function deleteCustomer(id) { await pool.query(`DELETE FROM customers WHERE id=$1`, [id]); }

// ---- Communications ----
async function addComm(d) {
  if (!d.direction) throw new Error("direction is required");
  const { rows } = await pool.query(
    `INSERT INTO communications (direction, channel, party, subject, body, status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [d.direction, d.channel || "email", d.party || null, d.subject || null, d.body || null, d.status || "logged"]
  );
  return rows[0];
}
async function listComms() {
  const { rows } = await pool.query(`SELECT * FROM communications ORDER BY created_at DESC LIMIT 200`);
  return rows;
}
async function deleteComm(id) { await pool.query(`DELETE FROM communications WHERE id=$1`, [id]); }

// ---- Calendar / Meetings ----
async function addEvent(d) {
  if (!d.title || !d.starts_at) throw new Error("title and starts_at are required");
  const { rows } = await pool.query(
    `INSERT INTO calendar_events (kind, title, starts_at, location, attendees, note)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [d.kind || "event", d.title, d.starts_at, d.location || null, d.attendees || null, d.note || null]
  );
  return rows[0];
}
async function listEvents() {
  const { rows } = await pool.query(`SELECT * FROM calendar_events ORDER BY starts_at ASC`);
  return rows;
}
async function updateEvent(id, d) {
  if (!d.title || !d.starts_at) throw new Error("title and starts_at are required");
  const { rows } = await pool.query(
    `UPDATE calendar_events
     SET kind=$1, title=$2, starts_at=$3, location=$4, attendees=$5, note=$6
     WHERE id=$7 RETURNING *`,
    [d.kind || "event", d.title, d.starts_at, d.location || null, d.attendees || null, d.note || null, id]
  );
  if (!rows.length) throw new Error("Event not found");
  return rows[0];
}
async function deleteEvent(id) { await pool.query(`DELETE FROM calendar_events WHERE id=$1`, [id]); }

module.exports = {
  addRevenue, listRevenue, deleteRevenue, revenueSummary,
  addCustomer, listCustomers, deleteCustomer,
  addComm, listComms, deleteComm,
  addEvent, listEvents, updateEvent, deleteEvent,
};
