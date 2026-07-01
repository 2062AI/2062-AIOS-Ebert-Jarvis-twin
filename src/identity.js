// identity.js — single source of truth for the agent's name/persona.
// Every module imports AGENT_NAME from here instead of redefining it, so the
// name can never drift across the codebase. Override in one place via .env.
//
//   AGENT_NAME=...   (optional; falls back to the canonical default below)

const AGENT_NAME = process.env.AGENT_NAME || "Ebert Sebastian Jarvis Pennyworth";

// Shared writing-quality rule applied to every agent's output so replies are
// clean and readable (proper grammar, punctuation, paragraphs, and markdown).
const WRITING_STYLE =
  "Write clearly and correctly. Use complete sentences, proper grammar and " +
  "punctuation, and short well-formed paragraphs — never terse fragments or " +
  "run-ons. Use markdown: **bold** for key points, `-` bullet lists for " +
  "enumerations, and short headings when a reply has multiple sections. " +
  "Proofread and self-edit before you answer.";

module.exports = { AGENT_NAME, WRITING_STYLE };
