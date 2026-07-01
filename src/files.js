// files.js — safe, allowlisted file access for the dashboard (Season 3).
// SECURITY: browsing/download/upload are restricted to explicitly-allowed roots.
// Every path is resolved and checked to ensure it cannot escape its root
// (no path traversal). The container can only see folders mounted into it.

const fs = require("fs");
const path = require("path");

// Allowed roots. Vault is always available; add more by mounting a host folder
// into the container and listing it in BROWSE_DIRS="Name:/container/path,...".
function getRoots() {
  const roots = [{ name: "Vault", dir: process.env.VAULT_PATH || "/vault" }];
  const extra = process.env.BROWSE_DIRS || "";
  extra
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const idx = pair.indexOf(":");
      if (idx > 0) {
        roots.push({ name: pair.slice(0, idx).trim(), dir: pair.slice(idx + 1).trim() });
      }
    });
  return roots;
}

function rootByName(name) {
  return getRoots().find((r) => r.name === name);
}

// Resolve a relative path within a root, refusing anything that escapes it.
function safeResolve(root, rel) {
  const base = path.resolve(root.dir);
  const target = path.resolve(base, rel || ".");
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("Path is outside the allowed folder");
  }
  return target;
}

function listRoots() {
  return getRoots().map((r) => ({ name: r.name, exists: fs.existsSync(r.dir) }));
}

function listDir(rootName, rel) {
  const root = rootByName(rootName);
  if (!root) throw new Error("Unknown folder");
  const dir = safeResolve(root, rel);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
    let size = 0;
    let mtime = null;
    try {
      const st = fs.statSync(path.join(dir, d.name));
      size = st.size;
      mtime = st.mtime;
    } catch {}
    return { name: d.name, type: d.isDirectory() ? "dir" : "file", size, mtime };
  });
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
  );
  return entries;
}

// Returns an absolute path to a file for download (after safety checks).
function resolveForDownload(rootName, rel) {
  const root = rootByName(rootName);
  if (!root) throw new Error("Unknown folder");
  const target = safeResolve(root, rel);
  const st = fs.statSync(target);
  if (!st.isFile()) throw new Error("Not a file");
  return target;
}

// Save an uploaded file (buffer) into an allowed root, default Vault/Uploads.
function saveUpload(rootName, rel, filename, buffer) {
  const root = rootByName(rootName || "Vault");
  if (!root) throw new Error("Unknown folder");
  const dir = safeResolve(root, rel || "Uploads");
  fs.mkdirSync(dir, { recursive: true });
  const clean = path.basename(filename || "upload").replace(/[^\w.\- ]/g, "_") || "upload";
  const dest = path.join(dir, clean);
  fs.writeFileSync(dest, buffer);
  return { name: clean, size: buffer.length, root: root.name, dir: rel || "Uploads" };
}

module.exports = { listRoots, listDir, resolveForDownload, saveUpload };
