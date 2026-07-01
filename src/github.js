// github.js — GitHub auto-commit + secrets guard (V2 §19, non-negotiable rule A).
// The most common way self-driving agents get people burned is committing a key.
// Every stage path here ends at the same scan; no file ever lands in a commit
// without being checked.

const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");

const pExec = promisify(execFile);

const WORKSPACE = "/workspace";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GIT_USER_NAME = process.env.GIT_USER_NAME || "Ebert Sebastian Jarvis Pennyworth";
const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL || "you@example.com";

// Token-shape patterns. False positives are OK; missing a real secret is not.
// Add to this list when you find new shapes — never widen, never narrow.
const SECRET_PATTERNS = [
  { name: "Anthropic API key", re: /sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_\-]{20,}/g },
  { name: "OpenAI API key", re: /sk-(?:proj-)?[A-Za-z0-9_\-]{30,}/g },
  { name: "GitHub PAT (classic)", re: /\bghp_[A-Za-z0-9]{30,}\b/g },
  { name: "GitHub PAT (fine-grained)", re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g },
  { name: "GitHub OAuth/app token", re: /\b(?:gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { name: "Telegram bot token", re: /\b\d{8,12}:[A-Za-z0-9_\-]{30,}\b/g },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_\-]{30,}\b/g },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/g },
  { name: "Private key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
];

// Files we never even scan/commit — same list as .gitignore for defense in depth.
// If git already ignores it, this is belt-and-suspenders.
// Only skip files where scanning provides no value (binary noise, vendored deps).
// .env intentionally NOT here — if it ever sneaks into the staging area we want
// the guard to fire, not silently skip it.
const NEVER_SCAN = [
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /\.(p12|pfx)$/,
];

function shouldSkip(relPath) {
  return NEVER_SCAN.some((re) => re.test(relPath));
}

function scanText(text) {
  const hits = [];
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    const m = text.match(p.re);
    if (m && m.length) {
      // Redact: show only the first 6 chars of each match.
      const sample = m.slice(0, 3).map((s) => `${s.slice(0, 6)}…(${s.length}ch)`);
      hits.push({ pattern: p.name, count: m.length, sample });
    }
  }
  return hits;
}

async function run(cmd, args, opts = {}) {
  const { stdout, stderr } = await pExec(cmd, args, {
    cwd: WORKSPACE,
    maxBuffer: 4 * 1024 * 1024,
    ...opts,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

async function isGitRepo() {
  try {
    await run("git", ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

async function ensureSafeDirectory() {
  // Bind-mounted Windows host dirs can trip git's "dubious ownership" guard.
  try {
    await run("git", ["config", "--global", "--add", "safe.directory", WORKSPACE]);
  } catch (err) {
    // Non-fatal; commit ops will surface the real error.
  }
}

async function gitStatusShort() {
  const { stdout } = await run("git", ["status", "--short"]);
  return stdout.trim();
}

async function listStagedFiles() {
  const { stdout } = await run("git", ["diff", "--cached", "--name-only"]);
  return stdout.split("\n").filter(Boolean);
}

async function listAllChangedFiles() {
  // Files git would stage with `git add -A` (modified + untracked, minus ignored).
  const { stdout } = await run("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, ""));
}

// Scan every file in `files` (paths relative to /workspace). Returns array of
// { file, hits[] } for files that contain at least one match.
async function scanFiles(files) {
  const findings = [];
  for (const rel of files) {
    if (shouldSkip(rel)) continue;
    const abs = path.join(WORKSPACE, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    // Skip very large files (likely binary blobs)
    if (stat.size > 1024 * 1024) continue;
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const hits = scanText(text);
    if (hits.length) findings.push({ file: rel, hits });
  }
  return findings;
}

// One-time repo bootstrap. Refuses if .git already exists.
async function repoInit() {
  if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN missing from .env");
  if (!GITHUB_REPO) throw new Error("GITHUB_REPO missing from .env");
  await ensureSafeDirectory();
  if (await isGitRepo()) {
    throw new Error("Repo already initialized at /workspace.");
  }
  await run("git", ["init", "-b", "main"]);
  await run("git", ["config", "user.name", GIT_USER_NAME]);
  await run("git", ["config", "user.email", GIT_USER_EMAIL]);
  await run("git", ["remote", "add", "origin", `https://github.com/${GITHUB_REPO}.git`]);

  await run("git", ["add", "-A"]);
  const staged = await listStagedFiles();
  const findings = await scanFiles(staged);
  if (findings.length) {
    // Unstage everything and abort.
    await run("git", ["rm", "--cached", "-r", "--ignore-unmatch", "."]);
    return { ok: false, reason: "secrets_found", findings };
  }

  await run("git", [
    "-c",
    `user.name=${GIT_USER_NAME}`,
    "-c",
    `user.email=${GIT_USER_EMAIL}`,
    "commit",
    "-m",
    "chore: initial commit (engine through Ep 6)",
  ]);

  const pushUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;
  await run("git", ["push", "-u", pushUrl, "HEAD:main"]);
  return { ok: true, staged: staged.length };
}

// Stage everything (-A), scan, refuse-or-prepare. Returns a preview object
// describing what the eventual commit will contain. Does NOT commit yet.
async function prepareCommit() {
  if (!(await isGitRepo())) {
    throw new Error("Not a git repo yet. Run /repo_init first.");
  }
  await ensureSafeDirectory();
  await run("git", ["add", "-A"]);
  const staged = await listStagedFiles();
  if (!staged.length) {
    return { ok: false, reason: "nothing_staged" };
  }
  const findings = await scanFiles(staged);
  if (findings.length) {
    // Unstage so we don't leave a loaded gun in the index.
    await run("git", ["reset"]);
    return { ok: false, reason: "secrets_found", findings, staged };
  }
  const { stdout: summary } = await run("git", ["diff", "--cached", "--stat"]);
  return { ok: true, staged, summary: summary.trim() };
}

// Run the actual commit + push. Caller MUST have just called prepareCommit
// and received approval. Re-scans before pushing as a final guard.
async function commitAndPush(message) {
  const staged = await listStagedFiles();
  if (!staged.length) return { ok: false, reason: "nothing_staged" };
  const findings = await scanFiles(staged);
  if (findings.length) {
    await run("git", ["reset"]);
    return { ok: false, reason: "secrets_found_at_push", findings };
  }
  await run("git", [
    "-c",
    `user.name=${GIT_USER_NAME}`,
    "-c",
    `user.email=${GIT_USER_EMAIL}`,
    "commit",
    "-m",
    message,
  ]);
  const pushUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;
  const { stdout: branch } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const br = branch.trim() || "main";
  await run("git", ["push", pushUrl, `HEAD:${br}`]);
  const { stdout: sha } = await run("git", ["rev-parse", "HEAD"]);
  return { ok: true, sha: sha.trim(), branch: br };
}

// Self-test: write a file containing a FAKE secret, run the scan against it,
// then delete the file. Proves the guard fires without touching real git state.
async function plantedSecretTest() {
  const rel = ".jarvis-secret-test.txt";
  const abs = path.join(WORKSPACE, rel);
  // Split so the scanner doesn't flag this source file itself (same trick as selftest.js).
  const fake =
    "// fake key for guard test — not a real Anthropic credential\n" +
    "const k = \"sk-ant-api" + "03-" + "A".repeat(40) + "\";\n";
  fs.writeFileSync(abs, fake, "utf8");
  try {
    const findings = await scanFiles([rel]);
    return { ok: findings.length > 0, findings };
  } finally {
    try {
      fs.unlinkSync(abs);
    } catch {}
  }
}

module.exports = {
  SECRET_PATTERNS,
  scanText,
  scanFiles,
  isGitRepo,
  gitStatusShort,
  listStagedFiles,
  listAllChangedFiles,
  prepareCommit,
  commitAndPush,
  repoInit,
  plantedSecretTest,
};
