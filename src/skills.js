// skills.js — owner-installed skills (reusable instruction sets Ebert can load).
// A skill is a Markdown file with YAML-ish frontmatter, stored in vault Skills/:
//   ---
//   name: ...
//   description: ...        (when to use it — drives auto-match)
//   enabled: true
//   ---
//   <instructions body>
//
// Skills are EXCLUDED from vault-search (they're instructions, not knowledge) and
// surfaced into the chat prompt via skillContextBlock() — auto-matched by the
// message, or forced with /skill <name>. All skill content is run through the
// intake safety gate before it's ever written here.

const fs = require("fs");
const path = require("path");

const VAULT_PATH = process.env.VAULT_PATH || "/vault";
const SKILLS_DIR = path.join(VAULT_PATH, "Skills");

function slugify(name) {
  return (
    String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "skill"
  );
}

function parse(text) {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  let body = text;
  if (m) {
    body = m[2] || "";
    for (const line of m[1].split(/\r?\n/)) {
      const mm = line.match(/^(\w+):\s*(.*)$/);
      if (mm) meta[mm[1]] = mm[2].trim();
    }
  }
  return { meta, body: body.trim() };
}

function compose({ name, description, body, enabled = true }) {
  return `---\nname: ${name}\ndescription: ${description || ""}\nenabled: ${enabled}\n---\n\n${(body || "").trim()}\n`;
}

function listSkills() {
  let files = [];
  try { files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md")); } catch { return []; }
  return files.map((f) => {
    const { meta, body } = parse(fs.readFileSync(path.join(SKILLS_DIR, f), "utf8"));
    const slug = f.replace(/\.md$/, "");
    return {
      slug,
      name: meta.name || slug,
      description: meta.description || "",
      enabled: meta.enabled !== "false",
      chars: body.length,
    };
  });
}

function getSkill(slug) {
  const p = path.join(SKILLS_DIR, `${slug}.md`);
  if (!fs.existsSync(p)) return null;
  const { meta, body } = parse(fs.readFileSync(p, "utf8"));
  return { slug, name: meta.name || slug, description: meta.description || "", enabled: meta.enabled !== "false", body };
}

// Write a skill file directly (used AFTER the intake gate has cleared the content).
function writeSkill({ name, description, body, enabled = true }) {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const slug = slugify(name);
  fs.writeFileSync(path.join(SKILLS_DIR, `${slug}.md`), compose({ name, description, body, enabled }), "utf8");
  return slug;
}

function setEnabled(slug, enabled) {
  const s = getSkill(slug);
  if (!s) throw new Error(`Skill not found: ${slug}`);
  fs.writeFileSync(path.join(SKILLS_DIR, `${slug}.md`), compose({ ...s, enabled }), "utf8");
  return getSkill(slug);
}

function deleteSkill(slug) {
  const p = path.join(SKILLS_DIR, `${slug}.md`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// --- auto-match: pick enabled skills whose name/description fit the message ---

function tokenize(s) {
  return String(s || "").toLowerCase().match(/[a-z0-9]{4,}/g) || [];
}

function findRelevant(message, { limit = 2 } = {}) {
  const q = new Set(tokenize(message));
  if (!q.size) return [];
  return listSkills()
    .filter((s) => s.enabled)
    .map((s) => {
      const terms = tokenize(`${s.name} ${s.description}`);
      let score = 0;
      for (const t of terms) if (q.has(t)) score++;
      return { ...s, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Prompt block of auto-matched skills. Empty string if none match.
function skillContextBlock(message) {
  const rel = findRelevant(message);
  if (!rel.length) return "";
  const blocks = rel.map((r) => {
    const full = getSkill(r.slug);
    return `## Skill: ${full.name}\n${full.body}`;
  });
  return (
    `=== ACTIVE SKILLS (owner-installed, safety-checked instructions — follow them for this request) ===\n` +
    `${blocks.join("\n\n")}\n=== END ACTIVE SKILLS ===`
  );
}

// Prompt block for one explicitly-named skill (for /skill <name>).
function namedSkillBlock(slug) {
  const s = getSkill(slug);
  if (!s) return "";
  return `=== ACTIVE SKILL: ${s.name} ===\n${s.body}\n=== END ACTIVE SKILL ===`;
}

module.exports = {
  SKILLS_DIR,
  slugify,
  parse,
  compose,
  listSkills,
  getSkill,
  writeSkill,
  setEnabled,
  deleteSkill,
  findRelevant,
  skillContextBlock,
  namedSkillBlock,
};
