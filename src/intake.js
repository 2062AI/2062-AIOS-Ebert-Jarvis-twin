// intake.js — universal safety gate. EVERY file entering the system (dashboard
// upload, skill upload, etc.) passes through inspect() before it's accepted.
// Verdict drives a traffic-light the owner sees:
//   🟢 green  (clean)   → accept straight into the system
//   🟡 amber  (flagged) → quarantine for owner review (bulk-approvable)
//   🔴 red    (toxic)   → HELD: quarantined but never bulk-approvable; needs an
//                         explicit, deliberate decision (or stays held).
//
// Reuses the existing secret guard (github.scanText) and prompt-injection
// detector (injection-guard.scan), plus type/size and skill-danger checks.

const fs = require("fs");
const path = require("path");
const github = require("./github");
const injectionGuard = require("./injection-guard");

const VAULT_PATH = process.env.VAULT_PATH || "/vault";
const QUARANTINE_DIR = path.join(VAULT_PATH, ".quarantine");
const MAX_BYTES = parseInt(process.env.INTAKE_MAX_BYTES || String(25 * 1024 * 1024), 10);

const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".json", ".csv", ".yaml", ".yml", ".html", ".xml", ".js", ".ts", ".py", ".base"]);
const ALLOWED_EXT = new Set([...TEXT_EXT, ".pdf", ".docx", ".doc", ".xlsx", ".pptx", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const BLOCKED_EXT = new Set([".exe", ".dll", ".sh", ".bat", ".cmd", ".ps1", ".scr", ".com", ".msi", ".app", ".jar", ".bin", ".vbs", ".so"]);

// Injection techniques severe enough to hold as TOXIC (vs merely flag).
const TOXIC_INJECTION = new Set(["secret-exfiltration", "jailbreak", "system-impersonation", "hide-from-owner"]);

// Dangerous directives specific to skills (which Jarvis would follow/act on).
const SKILL_DANGER = [
  { label: "shell-exec", re: /\b(rm\s+-rf|child_process|os\.system|subprocess|eval\(|\bexec\()/i },
  { label: "pipe-to-shell", re: /\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh)\b/i },
  { label: "reverse-shell", re: /\bnc\s+-e\b|\/dev\/tcp\//i },
  { label: "exfiltration", re: /\b(upload|post|send)\b[^.\n]{0,40}\b(env|\.env|api[_ ]?key|token|secret|credential)/i },
];

// Inspect a file. Returns { verdict, color, severity, checks[], summary, ... }.
// Never throws — a gate that crashes is a gate that's bypassed.
function inspect(filename, buffer, { isSkill = false } = {}) {
  const ext = path.extname(filename || "").toLowerCase();
  const size = buffer ? buffer.length : 0;
  const checks = [];
  let severity = 0; // 0 clean/green, 1 flagged/amber, 2 toxic/red
  const bump = (s) => { if (s > severity) severity = s; };

  if (size > MAX_BYTES) { checks.push({ name: "size", status: "fail", detail: `${size} bytes exceeds cap ${MAX_BYTES}` }); bump(2); }
  else checks.push({ name: "size", status: "pass", detail: `${size} bytes` });

  if (BLOCKED_EXT.has(ext)) { checks.push({ name: "type", status: "fail", detail: `blocked executable/script type "${ext}"` }); bump(2); }
  else if (!ALLOWED_EXT.has(ext)) { checks.push({ name: "type", status: "warn", detail: `unrecognized type "${ext || "(none)"}"` }); bump(1); }
  else checks.push({ name: "type", status: "pass", detail: ext });

  const isText = TEXT_EXT.has(ext);
  if (isText && buffer) {
    let text = "";
    try { text = buffer.toString("utf8"); } catch {}

    const sec = github.scanText(text);
    if (sec.length) { checks.push({ name: "secrets", status: "warn", detail: sec.map((h) => h.pattern).join(", ") }); bump(1); }
    else checks.push({ name: "secrets", status: "pass", detail: "none" });

    const inj = injectionGuard.scan(text);
    if (inj.flagged) {
      const toxic = inj.labels.some((l) => TOXIC_INJECTION.has(l));
      checks.push({ name: "prompt-injection", status: toxic ? "fail" : "warn", detail: inj.labels.join(", ") });
      bump(toxic ? 2 : 1);
    } else checks.push({ name: "prompt-injection", status: "pass", detail: "none" });

    if (isSkill) {
      const hits = SKILL_DANGER.filter((p) => p.re.test(text)).map((p) => p.label);
      if (hits.length) { checks.push({ name: "skill-danger", status: "fail", detail: hits.join(", ") }); bump(2); }
      else checks.push({ name: "skill-danger", status: "pass", detail: "none" });
    }
  } else if (ALLOWED_EXT.has(ext)) {
    checks.push({ name: "content", status: "pass", detail: "binary allowed type (not text-scanned)" });
  }

  const verdict = severity === 0 ? "clean" : severity === 1 ? "flagged" : "toxic";
  const color = severity === 0 ? "green" : severity === 1 ? "amber" : "red";
  const summary = checks.filter((c) => c.status !== "pass").map((c) => `${c.name}: ${c.detail}`).join("; ") || "all checks passed";
  return { verdict, color, severity, checks, summary, isText, ext, size };
}

// --- Quarantine (non-indexed; .quarantine is skipped by vault-search) -------

function quarantinePathFor(filename) {
  fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
  const clean = path.basename(filename || "upload").replace(/[^\w.\- ]/g, "_") || "upload";
  return path.join(QUARANTINE_DIR, `${Date.now().toString(36)}-${clean}`);
}

function writeQuarantine(filename, buffer) {
  const dest = quarantinePathFor(filename);
  fs.writeFileSync(dest, buffer);
  return dest;
}

function readQuarantine(qpath) {
  return fs.readFileSync(qpath);
}

function removeQuarantine(qpath) {
  try { if (qpath && qpath.startsWith(QUARANTINE_DIR)) fs.unlinkSync(qpath); } catch {}
}

module.exports = {
  inspect,
  writeQuarantine,
  readQuarantine,
  removeQuarantine,
  QUARANTINE_DIR,
  MAX_BYTES,
};
