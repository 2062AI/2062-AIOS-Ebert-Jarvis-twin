// backup.js — DB + vault backups with tiered 5-year retention.
// Dumps Postgres with pg_dump and snapshots the Obsidian vault to /backups
// (host-mounted). No secrets are included beyond operational data;
// the dump never contains .env or API keys.
//
// Retention tiers (DB dumps AND vault snapshots):
//   Daily   — last 7 days (one per day)
//   Weekly  — last 4 weeks beyond the daily window (one per week)
//   Monthly — last 60 months / 5 years (one per month)
//
// Vault Reports (.md files in /vault/Reports/) are kept for 5 years
// independently of the full vault snapshots.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { recordEvent } = require("./audit-log");
const { logDecision } = require("./decision-log");

const BACKUP_DIR = process.env.BACKUP_DIR || "/backups";
const VAULT_PATH = process.env.VAULT_PATH || "/vault";
const REPORTS_DIR = path.join(VAULT_PATH, "Reports");

// Retention limits (overridable via env).
const KEEP_DAILY   = parseInt(process.env.BACKUP_KEEP_DAILY   || "7",  10);
const KEEP_WEEKLY  = parseInt(process.env.BACKUP_KEEP_WEEKLY  || "4",  10);
const KEEP_MONTHLY = parseInt(process.env.BACKUP_KEEP_MONTHLY || "60", 10); // 5 years
const REPORT_KEEP_YEARS = parseInt(process.env.REPORT_KEEP_YEARS || "5", 10);

function tsStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function pgDump(outFile) {
  return new Promise((resolve, reject) => {
    const url = process.env.DATABASE_URL;
    if (!url) return reject(new Error("DATABASE_URL missing"));
    const out = fs.createWriteStream(outFile);
    const child = execFile("pg_dump", [url], { maxBuffer: 1024 * 1024 * 256 });
    child.stdout.pipe(out);
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("pg_dump failed: " + err))));
  });
}

// Extract ISO date string (YYYY-MM-DD) from a backup filename.
// Filenames: db-2026-06-26T03-00-00.sql  or  vault-2026-06-26T03-00-00
function dateFromName(name) {
  const m = name.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Tiered prune: keeps last KEEP_DAILY days, KEEP_WEEKLY weekly, KEEP_MONTHLY monthly.
// Files older than 5 years (KEEP_MONTHLY months) are deleted permanently.
function tieredPrune(prefix, dir) {
  try {
    const items = fs.readdirSync(dir)
      .filter(n => n.startsWith(prefix))
      .sort()
      .reverse(); // newest first

    const keep = new Set();
    const seenWeeks   = new Set();
    const seenMonths  = new Set();

    for (const name of items) {
      const dateStr = dateFromName(name);
      if (!dateStr) continue;
      const date = new Date(dateStr);
      const ageDays = (Date.now() - date.getTime()) / 86400000;

      if (ageDays <= KEEP_DAILY) {
        keep.add(name);
      } else if (ageDays <= KEEP_DAILY + KEEP_WEEKLY * 7) {
        // One per calendar week in the weekly window.
        const yr  = date.getFullYear();
        const wk  = Math.floor((date - new Date(yr, 0, 1)) / (7 * 86400000));
        const key = `${yr}-W${wk}`;
        if (!seenWeeks.has(key)) { seenWeeks.add(key); keep.add(name); }
      } else {
        // One per calendar month, up to KEEP_MONTHLY months.
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        if (!seenMonths.has(key) && seenMonths.size < KEEP_MONTHLY) {
          seenMonths.add(key); keep.add(name);
        }
        // Anything beyond KEEP_MONTHLY months is pruned (falls through).
      }
    }

    for (const name of items) {
      if (!keep.has(name)) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      }
    }
    return { kept: keep.size, total: items.length };
  } catch (e) {
    console.error(`[backup] tieredPrune(${prefix}) failed: ${e.message}`);
    return { kept: 0, total: 0 };
  }
}

// Prune vault Report .md files older than REPORT_KEEP_YEARS years.
// These are small text files so we keep them much longer than full snapshots.
function pruneVaultReports() {
  try {
    if (!fs.existsSync(REPORTS_DIR)) return { deleted: 0 };
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - REPORT_KEEP_YEARS);
    const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith(".md"));
    let deleted = 0;
    for (const f of files) {
      const dateStr = dateFromName(f);
      if (!dateStr) continue;
      if (new Date(dateStr) < cutoff) {
        fs.rmSync(path.join(REPORTS_DIR, f), { force: true });
        deleted++;
      }
    }
    return { deleted };
  } catch (e) {
    console.error(`[backup] pruneVaultReports failed: ${e.message}`);
    return { deleted: 0 };
  }
}

async function runBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = tsStamp();
  const result = { stamp, db: null, vault: null, pruned: {} };

  // 1) Database dump
  const dbFile = path.join(BACKUP_DIR, `db-${stamp}.sql`);
  await pgDump(dbFile);
  result.db = { file: path.basename(dbFile), bytes: fs.statSync(dbFile).size };

  // 2) Vault snapshot (recursive copy)
  const vaultDest = path.join(BACKUP_DIR, `vault-${stamp}`);
  if (fs.existsSync(VAULT_PATH)) {
    fs.cpSync(VAULT_PATH, vaultDest, { recursive: true });
    result.vault = { dir: path.basename(vaultDest) };
  }

  // 3) Tiered pruning (runs after the new backup is safely written)
  result.pruned.db    = tieredPrune("db-",    BACKUP_DIR);
  result.pruned.vault = tieredPrune("vault-", BACKUP_DIR);
  result.pruned.reports = pruneVaultReports();

  await recordEvent("backup_completed", {
    stamp,
    dbBytes: result.db.bytes,
    keptDb: result.pruned.db.kept,
    keptVault: result.pruned.vault.kept,
  });
  logDecision("backup_completed",
    `db=${result.db.bytes}B vault=${result.vault ? "ok" : "skipped"} ` +
    `kept db=${result.pruned.db.kept}/${result.pruned.db.total} vault=${result.pruned.vault.kept}/${result.pruned.vault.total}`
  );
  return result;
}

// List existing DB backups (for status reporting).
function listBackups() {
  try {
    const dbs = fs.readdirSync(BACKUP_DIR).filter(n => n.startsWith("db-")).sort().reverse();
    return dbs.map(f => {
      let bytes = 0;
      try { bytes = fs.statSync(path.join(BACKUP_DIR, f)).size; } catch {}
      return { file: f, bytes };
    });
  } catch {
    return [];
  }
}

module.exports = { runBackup, listBackups, pruneVaultReports, BACKUP_DIR };
