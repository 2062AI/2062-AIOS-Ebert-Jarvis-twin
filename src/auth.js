// auth.js — dashboard authentication (replaces the static chat-id header).
// Owner logs in with DASHBOARD_PASSWORD; the server issues a stateless,
// HMAC-signed session token (survives restarts as long as SESSION_SECRET is
// stable). No passwords or tokens are ever stored in the DB.

const crypto = require("crypto");

const PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || "";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7-day sessions

function configured() {
  return !!PASSWORD && !!SECRET;
}

function sign(expiry) {
  return crypto.createHmac("sha256", SECRET).update(String(expiry)).digest("hex");
}

// Constant-time string compare.
function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Verify the owner's password (constant-time).
function checkPassword(pw) {
  if (!configured()) return false;
  if (typeof pw !== "string" || pw.length !== PASSWORD.length) return false;
  return safeEqual(pw, PASSWORD);
}

// Issue a token of the form "<expiryMs>.<hmac>".
function issueToken() {
  const expiry = Date.now() + TTL_MS;
  return `${expiry}.${sign(expiry)}`;
}

// Validate a token: correct signature and not expired.
function verifyToken(token) {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const expiry = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(expiry)) return false;
  if (Date.now() > Number(expiry)) return false;
  const expected = sign(expiry);
  return mac.length === expected.length && safeEqual(mac, expected);
}

module.exports = { configured, checkPassword, issueToken, verifyToken };
