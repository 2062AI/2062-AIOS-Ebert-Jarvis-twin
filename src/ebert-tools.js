// ebert-tools.js — Ebert's hands (Season 4). Defines the tools the dashboard
// assistant can call and executes them against Jarvis's own modules.
//
// Ground rules:
//   - Every execution is written to the hash-chained audit log BEFORE the
//     result goes back to the model, so there is a tamper-evident record of
//     every action the agent takes.
//   - Tools only touch modules that already exist (trackers, tasks). No
//     shell, no filesystem, no network. Additive by design — the only
//     deletion tool is nothing: Ebert cannot delete anything.
//   - The tool loop in web-server caps iterations, and every LLM round-trip
//     still passes the cost governor preflight. Kill switch halts mid-loop.

const trackers = require("./trackers");
const tasks = require("./tasks");
const { recordEvent } = require("./audit-log");

// --- Tool definitions (Anthropic tool-use schema) ---------------------------

const TOOLS = [
  {
    name: "add_calendar_event",
    description:
      "Add an event, deadline, task, or meeting to the owner's Jarvis calendar. " +
      "Use when she asks to schedule, remind, or set a deadline for something.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short event title" },
        starts_at: { type: "string", description: "ISO datetime, e.g. 2026-07-15T09:00:00 (owner is America/Chicago)" },
        kind: { type: "string", enum: ["event", "meeting", "deadline", "task"], description: "Type of entry" },
        note: { type: "string", description: "Optional context/notes" },
        location: { type: "string", description: "Optional location or link" },
      },
      required: ["title", "starts_at"],
    },
  },
  {
    name: "list_calendar_events",
    description: "List upcoming calendar events/deadlines so you can answer questions about what's coming up.",
    input_schema: {
      type: "object",
      properties: {
        days_ahead: { type: "number", description: "How many days ahead to look (default 14)" },
      },
    },
  },
  {
    name: "create_task",
    description: "Create a task in Jarvis's task list. Use when the owner asks you to track a to-do that isn't calendar-bound.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task title" },
        description: { type: "string", description: "Optional details" },
      },
      required: ["title"],
    },
  },
];

// --- Execution --------------------------------------------------------------

// Executes one tool call. Never throws — returns { ok, result | error } so a
// failed tool becomes information for the model, not a crashed request.
async function execute(name, input) {
  try {
    let result;
    switch (name) {
      case "add_calendar_event": {
        const ev = await trackers.addEvent({
          title: input.title,
          starts_at: input.starts_at,
          kind: input.kind || "event",
          note: input.note || null,
          location: input.location || null,
        });
        result = { created: { id: ev.id, title: ev.title, starts_at: ev.starts_at, kind: ev.kind } };
        break;
      }
      case "list_calendar_events": {
        const days = Math.min(Math.max(input.days_ahead || 14, 1), 365);
        const all = await trackers.listEvents();
        const now = Date.now();
        const horizon = now + days * 86400000;
        result = {
          events: all
            .filter((e) => {
              const t = new Date(e.starts_at).getTime();
              return t >= now - 86400000 && t <= horizon;
            })
            .slice(0, 40)
            .map((e) => ({ id: e.id, title: e.title, starts_at: e.starts_at, kind: e.kind, note: e.note })),
        };
        break;
      }
      case "create_task": {
        const t = await tasks.createTask({ title: input.title, description: input.description || null });
        result = { created: { id: t.id, title: t.title, status: t.status } };
        break;
      }
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
    // Audit BEFORE returning to the model: tamper-evident record of the action.
    await recordEvent("ebert_tool_call", { tool: name, input, ok: true });
    return { ok: true, result };
  } catch (e) {
    await recordEvent("ebert_tool_call", { tool: name, input, ok: false, error: e.message });
    return { ok: false, error: e.message };
  }
}

module.exports = { TOOLS, execute };
