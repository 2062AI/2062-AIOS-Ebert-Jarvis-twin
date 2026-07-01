# AIOS — a personal AI Operating System

**Ebert** is a self-hosted AI agent platform you run on your own machine. It manages missions, remembers your notes, takes real actions on your behalf — and governs its own spending and safety while doing it.

This is the open-source twin of a private personal build, developed episode by episode as a filmed series. Same engine, same controls — loaded with fictional sample data so you can start from zero and make it yours.

Node.js · PostgreSQL · Docker · Claude API · Telegram · zero frameworks, 7 dependencies.

```
┌─────────────┐     ┌──────────────────────────────────────────────┐
│  Telegram    │     │                  AIOS ENGINE                 │
│  (owner-only)│────▶│  ┌─────────────┐   ┌───────────────────┐   │
└─────────────┘     │  │ Cost         │   │ LLM Router         │   │
┌─────────────┐     │  │ Governor     │──▶│ retry · timeout ·  │──▶ Claude API
│  Dashboard   │────▶│  │ preflight    │   │ prompt caching     │   │
│  (localhost, │     │  │ + kill switch│   └───────────────────┘   │
│  password)   │     │  └─────────────┘   ┌───────────────────┐   │
└─────────────┘     │  ┌─────────────┐   │ Ebert (assistant)  │   │
                    │  │ Intake Gate  │   │ memory · vision ·  │   │
     Uploads ──────▶│  │ 🟢🟡🔴 triage │   │ tools · vault RAG  │   │
                    │  └─────────────┘   └───────────────────┘   │
                    │  ┌──────────────────────────────────────┐  │
                    │  │ Hash-chained audit log (tamper-evident)│  │
                    │  └──────────────────────────────────────┘  │
                    └───────┬──────────────┬───────────┬─────────┘
                            ▼              ▼           ▼
                       PostgreSQL    Obsidian Vault  Tiered Backups
                       (state)       (knowledge)     (7d/4w/60mo)
```

## Why this is different

Most agent demos skip the unglamorous parts: budgets, audit trails, tamper evidence, quarantine, failure handling. AIOS is built **safety-first** — the control layer isn't a feature, it's the foundation everything else sits on.

### The control layer

| Control | What it does |
|---|---|
| **Cost governor** | Every LLM call passes a `preflight()` budget check first. Hitting the daily cap **auto-trips the kill switch** — nothing else can spend until you act. Cache-aware pricing so cached tokens still count. |
| **Kill switch** | One Telegram tap (`/killswitch_on`) halts all LLM spend, mid-task, everywhere — including mid-tool-loop. |
| **Hash-chained audit log** | Append-only event log where each row's hash covers the previous row's. Editing any historical row breaks the chain; `verifyChain()` detects it. Pruned rows are archived, never lost, and the chain stays verifiable. |
| **Intake gate** | Every file entering the system is inspected and triaged 🟢 clean / 🟡 quarantined / 🔴 toxic. Red files are *never* bulk-approvable. The gate never throws — a gate that crashes is a gate that's bypassed. |
| **Prompt-injection defense** | Vault content and extracted document text are scanned for injection patterns before they can reach the model. Untrusted content is fenced as reference data, never instructions. |
| **Secret guard** | A pre-push scanner blocks API keys/credentials from ever reaching GitHub. `.env` is gitignored, non-negotiable. |
| **Agent tool audit** | Every action the assistant takes (calendar writes, task creation) is written to the audit chain **before** the result returns to the model. |

### The capability layer

- **Ebert** — the assistant. Conversation memory, vision, document reading (PDF/DOCX), vault-aware retrieval (zero-dependency RAG over Obsidian markdown), and **tool use**: it can add calendar events, create tasks, and read live trackers — all budgeted and audited.
- **Missions** — long-running goals with milestones, categories, and LLM-drafted plans (approve-before-execute). Ships with fictional samples; the onboarding interview creates yours.
- **Sub-agents** — named domain specialists (strategy, revenue, research, building, training…) with per-agent chat history and collaboration.
- **Schedulers** — morning brief, evening report, weekly review, nightly backup, Sunday maintenance — each cron-driven, each zero- or one-LLM-call by design.
- **Dashboard** — vanilla JS single-page app: missions, approvals, calendar, revenue/customers, file manager with upload triage, live system-health probes.
- **Telegram** — owner-locked bot with a full slash-command menu; free-form chat routes to Ebert with session-gap detection.

### The ops layer

- **Tiered backups**: 7 daily / 4 weekly / 60 monthly (5 years), for both the Postgres dump and the vault snapshot. Pruning runs only after the new backup is safely written.
- **Retention**: audit log 60-day active window (archived, chain-verifiable), usage log 1 year, agent transcripts 90 days — enforced by a Sunday maintenance cron that reports what it pruned.
- **Tests**: a `node --test` unit suite covering the cost math, the audit chain, and the intake gate — the three places a silent bug costs money or trust.

## Stack honesty

- **LLM-agnostic by design, Anthropic-implemented today.** The router abstracts providers and routes task types to models; Claude is the only wired provider so far.
- **No frameworks.** Express for HTTP, `pg` for Postgres, vanilla JS frontend. 7 total dependencies — a deliberately small attack/maintenance surface.
- **Single-owner by design.** This is a personal OS, not a SaaS. Auth is a password + session on a localhost-bound port; the compose file refuses to expose the dashboard without auth (fail-closed).

## Run it

```bash
cp .env.example .env    # fill in TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ANTHROPIC_API_KEY, DASHBOARD_PASSWORD
docker compose up --build
```

- Dashboard: http://localhost:3000 (password login)
- Telegram: message your bot `/start` for the onboarding interview — this is where it stops being a demo and becomes *your* system
- Tests: `docker exec aios node --test test/`

The knowledge vault lives in a **sibling** folder (`../Jarvis-Vault`, an Obsidian vault) and is never committed. Backups land in `../Jarvis-Backups`.

## Layout

```
src/
  index.js          Telegram entrypoint + command dispatch
  web-server.js     Dashboard API (chat, tools, uploads, trackers)
  llm-router.js     Provider abstraction: retry, timeout, prompt caching
  cost-governor.js  Budget cap + kill switch (preflight before every call)
  audit-log.js      Hash-chained tamper-evident event log
  intake.js         Universal file safety gate (green/amber/red)
  ebert-tools.js    The assistant's audited action tools
  vault-search.js   Zero-dep retrieval over the Obsidian vault
  scheduler.js      Cron: briefs, reports, backups, maintenance
  missions.js       Mission registry + milestones
  sub-agents.js     Named domain specialists
  backup.js         Tiered 5-year retention backups
  ...
public/             Dashboard SPA (vanilla JS)
test/               node --test unit suite (safety-critical paths)
```

## License

GPL-3.0 — see [LICENSE](LICENSE) and [COPYRIGHT](COPYRIGHT). Build on it, share your improvements.
