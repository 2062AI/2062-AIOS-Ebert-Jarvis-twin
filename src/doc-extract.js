// doc-extract.js — pull readable text out of uploaded documents so Ebert can
// actually read them in chat. Supports .txt/.md (native), .docx (mammoth),
// and .pdf (pdf-parse). Returns plain text capped to a sane length so a big
// file doesn't blow the chat token budget.

const MAX_CHARS = 8000; // ~2k tokens of document context per file

function cap(text) {
  if (!text) return "";
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= MAX_CHARS) return clean;
  return clean.slice(0, MAX_CHARS) + "\n\n…[truncated — full file is in the vault]";
}

// Extract text from a file buffer. `name` is the original filename (for the
// extension). Returns { text, kind } or { text: "", kind, error } on failure.
async function extractText(name, buffer) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  try {
    if (ext === "txt" || ext === "md" || ext === "markdown" || ext === "csv") {
      return { text: cap(buffer.toString("utf8")), kind: ext };
    }
    if (ext === "docx") {
      const mammoth = require("mammoth");
      const { value } = await mammoth.extractRawText({ buffer });
      return { text: cap(value), kind: "docx" };
    }
    if (ext === "pdf") {
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(buffer);
      return { text: cap(data.text), kind: "pdf" };
    }
    if (ext === "doc") {
      return { text: "", kind: "doc", error: "Legacy .doc not supported — save as .docx and re-upload." };
    }
    return { text: "", kind: ext, error: `Can't read .${ext} files yet.` };
  } catch (e) {
    return { text: "", kind: ext, error: e.message };
  }
}

function isExtractable(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return ["txt", "md", "markdown", "csv", "docx", "pdf"].includes(ext);
}

module.exports = { extractText, isExtractable };
