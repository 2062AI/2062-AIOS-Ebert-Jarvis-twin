// llm-router.js — one interface for any model (V1 §6.1, Ep 12 multi-LLM routing).
// Keys come from process.env, never from notes or the vault.
// Supports multiple providers; routes task types to preferred models.
// Fallback: if preferred model is unavailable, uses fallback.
//
// Hardening (Season 4 review):
//   - Every request has a hard timeout (AbortController) so a hung socket
//     can't hang Jarvis forever.
//   - Retries with exponential backoff on 429 (rate limit), 529 (overloaded),
//     and transient network errors. Non-retryable errors fail fast.
//   - Prompt caching: pass `cacheSystem: true` to mark the system prompt with
//     cache_control so repeat turns re-read it at ~10% of input price.
//   - callMessages() accepts a full messages array + optional tools, enabling
//     multi-turn memory and agentic tool use. call() remains for simple asks.

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const CLAUDE_CODE_MODEL = process.env.CLAUDE_CODE_MODEL || "claude-opus-4-8";
const MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || "1024", 10);
const TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || "90000", 10);
const MAX_RETRIES = parseInt(process.env.LLM_MAX_RETRIES || "3", 10);

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class LLMRouter {
  constructor() {
    // Define all supported providers (Anthropic only for now; Gemini/GPT come later)
    this.providers = {
      claude: {
        type: "anthropic",
        url: "https://api.anthropic.com/v1/messages",
        key: process.env.ANTHROPIC_API_KEY,
        model: CLAUDE_MODEL,
      },
      claude_code: {
        type: "anthropic",
        url: "https://api.anthropic.com/v1/messages",
        key: process.env.ANTHROPIC_API_KEY,
        model: CLAUDE_CODE_MODEL,
      },
      // Future: Gemini, GPT, Ollama — same shape, add to ACTIVE_PROVIDERS below
    };

    // Task type → preferred provider. Falls back to "claude" if unavailable.
    this.routing = {
      draft: "claude",
      ask: "claude",
      plan: "claude",
      execute: "claude",
      mission_plan: "claude",
      mission_execute: "claude",
      improvement: "claude",
      mission_draft: "claude",
      content: "claude_code", // Ep 13: content creation (has more nuance)
      code: "claude_code",    // For future code-generation tasks
    };

    this.activeProviders = process.env.ACTIVE_PROVIDERS
      ? process.env.ACTIVE_PROVIDERS.split(",").map((s) => s.trim())
      : ["claude"];
  }

  pick(taskType) {
    const preferred = this.routing[taskType] || "claude";
    const prov = this.providers[preferred];
    if (this.activeProviders.includes(preferred) && prov && prov.key) {
      return { name: preferred, ...prov };
    }
    const fallback = this.providers.claude;
    if (!fallback || !fallback.key) {
      throw new Error("No active LLM provider configured (ANTHROPIC_API_KEY missing)");
    }
    return { name: "claude", ...fallback };
  }

  // Simple single-turn call (kept for every existing caller).
  // `images` is an optional array of { dataBase64, mediaType } for vision.
  async call(prompt, { taskType = "draft", system = "", maxTokens = MAX_TOKENS, images = [], cacheSystem = false } = {}) {
    let content;
    if (images && images.length) {
      content = [
        ...images.map((img) => ({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.dataBase64 },
        })),
        { type: "text", text: prompt || "Describe what you see." },
      ];
    } else {
      content = prompt;
    }
    const r = await this.callMessages({
      taskType,
      system,
      maxTokens,
      cacheSystem,
      messages: [{ role: "user", content }],
    });
    return { text: r.text, provider: r.provider, usage: r.usage };
  }

  // Full-fidelity call: multi-turn messages, optional tools.
  // Returns { text, content, stopReason, provider, usage }.
  //   text       — concatenated text blocks (convenience)
  //   content    — raw content blocks (needed for tool_use loops)
  //   stopReason — "end_turn" | "tool_use" | "max_tokens" | ...
  async callMessages({ taskType = "ask", system = "", maxTokens = MAX_TOKENS, messages = [], tools = null, cacheSystem = false } = {}) {
    const prov = this.pick(taskType);
    if (prov.type !== "anthropic") {
      throw new Error(`Provider type ${prov.type} not yet implemented`);
    }

    const body = {
      model: prov.model,
      max_tokens: maxTokens,
      messages,
    };
    if (system) {
      // With cacheSystem, send system as a content block marked ephemeral so
      // Anthropic caches the prefix (repeat turns bill ~10% for those tokens).
      // Callers may also pass a pre-built array of blocks (e.g. a stable
      // cached prefix + a variable uncached suffix) — pass those through.
      body.system = Array.isArray(system)
        ? system
        : cacheSystem
          ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
          : system;
    }
    if (tools && tools.length) body.tools = tools;

    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // 1s, 2s, 4s (+ jitter) — bounded, then give up with the real error.
        const backoff = 1000 * 2 ** (attempt - 1) + Math.random() * 250;
        console.warn(`[llm] retry ${attempt}/${MAX_RETRIES} in ${Math.round(backoff)}ms — ${lastErr && lastErr.message}`);
        await sleep(backoff);
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(prov.url, {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": prov.key,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        });
        const data = await res.json();

        if (!res.ok) {
          const msg = data && data.error ? data.error.message : `HTTP ${res.status}`;
          const err = new Error(`LLM call failed: ${msg}`);
          if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
            lastErr = err;
            continue;
          }
          throw err;
        }

        const text = (data.content || [])
          .filter((b) => b.type === "text")
          .map((b) => b.text || "")
          .join("");
        return {
          text,
          content: data.content || [],
          stopReason: data.stop_reason || null,
          provider: prov.model,
          usage: data.usage || null, // includes cache_*_input_tokens when caching
        };
      } catch (err) {
        // AbortError (timeout) and network flakes are retryable.
        const transient = err.name === "AbortError" || err.name === "TypeError" || /fetch failed|ECONNRESET|ETIMEDOUT/i.test(err.message);
        if (transient && attempt < MAX_RETRIES) {
          lastErr = err.name === "AbortError" ? new Error(`LLM request timed out after ${TIMEOUT_MS}ms`) : err;
          continue;
        }
        throw err.name === "AbortError" ? new Error(`LLM request timed out after ${TIMEOUT_MS}ms`) : err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error("LLM call failed after retries");
  }
}

module.exports = { LLMRouter };
