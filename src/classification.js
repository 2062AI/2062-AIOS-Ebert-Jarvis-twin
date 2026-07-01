// classification.js — 3-tier data classification (Demo Agent & Data Classification Spec).
// TIER 1 PRIVATE  — personal/business/secret; never in demo or public.
// TIER 2 DEMO     — sanitized, showcase-safe.
// TIER 3 PUBLIC   — open-source code/docs/templates.
// Rule from the spec: when unsure, default to TIER 1 (over-protect).

const fs = require("fs");

const TIERS = {
  T1: { id: "TIER-1-PRIVATE", label: "Private", level: 1 },
  T2: { id: "TIER-2-DEMO", label: "Demo-Safe", level: 2 },
  T3: { id: "TIER-3-PUBLIC", label: "Public", level: 3 },
};

// Determine tier from explicit frontmatter, then content markers, then path,
// then default to TIER 1.
function classifyText(text = "", relPath = "") {
  const head = text.slice(0, 600).toUpperCase();
  const p = relPath.toUpperCase();

  // 1) Explicit frontmatter: classification: TIER-1-PRIVATE (or 1/2/3)
  const fm = text.match(/^\s*classification:\s*(.+)$/im);
  if (fm) {
    const v = fm[1].toUpperCase();
    if (/3|PUBLIC/.test(v)) return TIERS.T3;
    if (/2|DEMO/.test(v)) return TIERS.T2;
    if (/1|PRIVATE/.test(v)) return TIERS.T1;
  }

  // 2) Content markers written into the spec headers themselves
  if (/TIER\s*1|PRIVATE/.test(head)) return TIERS.T1;
  if (/TIER\s*2|DEMO[-\s]?SAFE/.test(head)) return TIERS.T2;
  if (/TIER\s*3|PUBLIC/.test(head)) return TIERS.T3;

  // 3) Path heuristics
  if (/\/DEMO\//.test("/" + p)) return TIERS.T2;
  if (/\/PUBLIC\/|TEMPLATE/.test("/" + p)) return TIERS.T3;
  if (/CONFIG|MEMORY|OWNER|PROFILE|REPORT|ANALYTIC/.test(p)) return TIERS.T1;

  // 4) Default: protect
  return TIERS.T1;
}

function classifyFile(absPath, relPath = "") {
  try {
    const text = fs.readFileSync(absPath, "utf8");
    return classifyText(text, relPath || absPath);
  } catch {
    return TIERS.T1;
  }
}

// Audience-based enforcement. "owner" sees everything (private channels);
// "demo" sees TIER 2+; "public" sees TIER 3 only.
const AUDIENCE_MIN_LEVEL = { owner: 1, demo: 2, public: 3 };

function isAllowedFor(tierLevel, audience = "owner") {
  const min = AUDIENCE_MIN_LEVEL[audience] || 1;
  return tierLevel >= min;
}

module.exports = { classifyText, classifyFile, isAllowedFor, AUDIENCE_MIN_LEVEL, TIERS };
