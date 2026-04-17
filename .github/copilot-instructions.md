# Copilot Instructions — taskbean

## Repository Structure

This is a **monorepo** with two halves of the same product:

| Directory | What | Tech |
|-----------|------|------|
| `cli/` | Agent-facing CLI tool — `bean add`, `bean done`, `bean report` | Node.js, commander, SQLite |
| `app/` | Human-facing desktop PWA — dashboard, AI chat, reminders | FastAPI + Express, Foundry Local, vanilla JS |

Both share `~/.taskbean/taskbean.db`. The CLI writes tasks; the app displays and manages them.

## CLI (`cli/`)

- Entry point: `cli/bin/taskbean.js` (aliased as `bean`)
- 17 commands in `cli/src/commands/` (add, block, count, done, edit, export, init, install, list, package, projects, remind, remove, report, serve, start, track)
- SQLite access in `cli/src/data/store.js`; attribution logic in `cli/src/data/attribution.js`
- `cli/pwa/` — minimal standalone dashboard served by `bean serve` (separate from `app/public/`)
- `cli/evals/` — agent-skill evaluation scenarios (not a normal test suite)
- Tests: `npm test` from `cli/` runs `node --test src/**/*.test.js` (integration-style, hits SQLite)
- Install scripts: `cli/scripts/install.sh`, `cli/scripts/install.ps1`
- npm package name: `taskbean`

### Agent skill installation

The CLI ships as an [Agent Skill](https://agentskills.io) via `.agents/skills/taskbean/SKILL.md`. `bean install` places the skill in the right folder for each agent:

- `.agents/skills/` → Copilot CLI, Codex, OpenCode (default)
- `.claude/skills/` → Claude Code (needs `--agent claude`; it does NOT scan `.agents/skills/`)
- `--agent codex --codex-sandbox` also whitelists `~/.taskbean` in `~/.codex/config.toml`

Skill wrappers set `TASKBEAN_AGENT` + `TASKBEAN_NATIVE_SESSION_ID` env vars so `bean add` gets accurate attribution (tier 2 of the 4-tier precedence — see below).

## Desktop App (`app/`)

**Dual-backend** local AI todo app powered by [Foundry Local](https://github.com/microsoft/foundry-local) (on-device NPU/GPU/CPU inference). Both backends serve the same single-page frontend and share the same API contract.

### Two backends, one frontend

| Backend | Entry point | Framework | When to use |
|---------|-------------|-----------|-------------|
| **Node.js** | `server.js` | Express 5 | Standalone — in-process inference via `foundry-local-sdk` native FFI |
| **Python** | `agent/main.py` | FastAPI + uvicorn | Primary — uses `agent-framework` + `agent-framework-ag-ui` for multi-turn tool-calling |

The Python backend is the primary backend. The Node.js backend is legacy but still functional.

Both backends use the Foundry Local SDK for in-process inference (no external service needed). The Node.js backend uses `FoundryLocalManager.create()` with auto-discovery; do NOT pass a custom `libraryPath` — it breaks EP (execution provider) registration for NPU models.

### Python agent module structure

| File | Role |
|------|------|
| `agent/main.py` | FastAPI app, routes, SSE endpoints, startup lifecycle |
| `agent/agent.py` | Agent construction and model lifecycle (build/rebuild after switch) |
| `agent/tools.py` | `@tool`-decorated functions: `add_task`, `set_reminder`, `complete_task`, etc. |
| `agent/state.py` | In-memory store — `todos` dict and `recurring_templates` dict |
| `agent/app_config.py` | Persistent config at `~/.taskbean/config.json`, model-switch lock |
| `agent/hardware.py` | Windows NPU/GPU/CPU detection via WMI/PowerShell |
| `agent/telemetry.py` | OTel pipeline + `UISpanExporter` for nerd panel |
| `agent/notifications.py` | Windows toast notifications (optional `win10toast`) |
| `agent/recommender.py` | Model recommendation engine for hardware-based selection |
| `agent/context.py` | Token counting via `tiktoken` + chunked extraction for large docs |

State is **in-memory only** — todos and recurring templates live in `state.py` dicts and reset on restart. Config persists to `~/.taskbean/config.json` (migrated from legacy `~/.foundry-local-demo/`).

### Key data flow

```
Browser (public/index.html)
  → POST /api/command (AG-UI SSE)
    → Agent/AI completes with tools → Foundry Local SDK → NPU/GPU/CPU inference
    → Tool calls mutate state (in-memory todos)
    → AG-UI events stream back: STATE_SNAPSHOT, STATE_DELTA, TEXT_MESSAGE_CONTENT
```

Long text input (e.g., pasted docs) goes to `/api/extract` instead — `handleSend()` routes based on content length.

### Telemetry — single OTel pipeline

Telemetry uses a **single OpenTelemetry pipeline**. There is no separate ring buffer or bespoke event system.

```
OTel SDK (auto-instrumentation + manual spans)
  → SimpleSpanProcessor → UISpanExporter → nerd panel SSE stream
  → BatchSpanProcessor  → OTLP/gRPC     → Jaeger v2.17
```

- **`UISpanExporter`** (in `telemetry.js` and `agent/telemetry.py`) converts completed OTel spans into JSON events for the nerd panel. It whitelist-filters to only export app-level spans (`ai.complete`, `ai.completeWithTools`, `tool.*`, `model.switch`).
- **`health.snapshot`** and **`metric.sample`** are direct SSE pushes (not spans) — they bypass the OTel pipeline.
- **GenAI semantic conventions**: AI spans carry `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.request.model`, `gen_ai.response.finish_reason`.
- Token counts come from the SDK's standard `response.usage` field — streaming chunks include `usage` on every chunk (Foundry Local always provides this). Capture `chunk.usage` BEFORE the `if (!delta) continue` guard.

### Foundry Local SDK — EP registration

The SDK auto-discovers and registers execution providers (VitisAI for NPU, MIGraphX for GPU) via `downloadAndRegisterEps()`. Critical rules:
- Let the SDK auto-discover native libraries — do NOT pass `libraryPath` to `FoundryLocalManager.create()`.
- After EP registration, invalidate the server-level model catalog cache (`_modelCatalogCache = null`) so NPU models appear in the API.
- `foundry-local-sdk-winml` must be installed for NPU support. Run `node script/install-winml.cjs` if native DLLs are missing.

### Frontend

Single-file SPA in `public/index.html` (~7900 lines). No build step, no bundler. Vanilla JS, CSS custom properties for theming (dark-roast/latte/espresso/black-coffee), Lucide icons via CDN, `fast-json-patch` for AG-UI state deltas. PWA support via `sw.js` and `manifest.json`.

The telemetry panel has 4 tabs: **Events** (with filter chips + search), **Metrics** (sparkline cards), **Traces** (native waterfall via `/api/traces` Jaeger proxy), **Logs** (severity-filtered log records).

Chat submission uses `handleSend()` triggered by Enter key on `#chatInput` textarea — there is no submit button.

## Build & Run

### Python backend (primary)

```bash
cd app/agent
pip install -r requirements.txt
python main.py                    # starts on :8275, auto-starts Jaeger
```

### Node.js backend (legacy)

```bash
cd app
npm install
node server.js                    # starts on :8275, auto-starts Jaeger
```

### One-click launch

`app/launch.cmd` / `app/launch.ps1` — installs prerequisites, registers `taskbean://` protocol handler, starts the Python server, and opens the browser.

### Jaeger v2 (tracing)

`docker-compose.yml` runs Jaeger v2.17 (OTel Collector-based). Config in `jaeger-config.yaml`. Includes SpanMetrics connector for R.E.D. metrics with `gen_ai.request.model` dimension. UI at `http://localhost:16686`.

## Testing

### Python integration tests

```bash
cd app/agent
pytest test_integration.py -v                          # all tests
pytest test_integration.py -v -k test_health_ready     # single test
pytest test_telemetry.py -v                            # telemetry-specific tests
pytest test_race.py -v                                 # concurrency tests
pytest test_integration.py -v -m slow                  # includes model-switch
```

Tests start a real uvicorn server on port 3001 — no mocking. Shared fixtures in `conftest.py`:
- `live_server` (session-scoped) — starts uvicorn in a background thread, waits up to 6 min for model load via `/api/health` polling
- `client` (session-scoped) — `httpx.AsyncClient` with 120s timeout
- `clean_state` — clears `state.todos` and `state.recurring_templates` before/after test
- `collect_sse()` — helper to POST to SSE endpoints and collect events until a target event type arrives

### Playwright E2E tests

```bash
cd app
npx playwright test                                    # all specs (22 files)
npx playwright test tests/smoke.spec.js                # single spec
npx playwright test -g "page loads"                    # single test by title
npx playwright test --project=smoke                    # smoke project only
```

Requires the server running on `:8275`. Config uses 3 projects with dependencies: `smoke` runs first, then `features` and `model-tests` run after smoke passes. Runs in Edge (`channel: 'msedge'`), records trace/video on failure.

Note: `npm test` runs `node test.js` (legacy Node test), not Playwright.

## Key Conventions

### SSE is the transport for everything complex

`/api/command`, `/api/extract`, `/api/models/switch`, and telemetry streams all use Server-Sent Events.

### Model switching is guarded

Model switch acquires `app_config.get_switch_lock()`. Flow: unload all models → download if needed (with progress events) → load → rebuild agent. Always rebuild after switch.

### Foundry SDK calls must be threaded (Python)

All `foundry-local-sdk` FFI calls block. Wrap in `await asyncio.to_thread(...)`:
```python
model = await asyncio.to_thread(lambda: manager.catalog.get_model(alias))
await asyncio.to_thread(model.load)
```

### CORS is localhost-only

`allow_origin_regex` matches `^https?://(localhost|127\.0\.0\.1)(:\d+)?$` — no wildcard. This is a private local AI app.

### File extraction via MCP

Large file/paste input goes through `/api/extract` which uses MCP (Model Context Protocol) + MarkItDown for document conversion, then `context.py` for token-counted chunking.

### Windows-specific code

- `strftime`: `%#d` on Windows, `%-d` on POSIX
- Hardware detection: WMI/PowerShell queries in `hardware.py`
- Notifications: `win10toast` — optional, gracefully skipped if unavailable
- Protocol handler: `taskbean://` registered by `launch.ps1` for PWA server restart

### Tool parity

`agent/tools.py` (Python) and `NL_TOOLS` in `server.js` define the same tool set. Keep them in sync when adding tools.

### Python backend owns agent-usage writes

`agent_sessions`, `agent_turns`, `agent_sources`, and `agent_settings` are **only** written by the Python backend (scanners under `app/agent/usage/`). The CLI reads these tables but never writes them. The CLI continues to own `todos` (including the new `todos.agent` and `todos.agent_session_id` attribution columns).

## Multi-agent usage tracking

taskbean ingests session and token-usage metadata from the coding agents installed on the machine (Copilot CLI, Claude Code, Codex, OpenCode) and attributes each `bean add` to the agent/session that triggered it.

### Schema (in `cli/src/data/store.js`)

| Table | Role |
|-------|------|
| `agent_sessions` | One row per detected session across all agents. PK is the composite id `"{agent}:{native_id}"`. Columns: `agent, native_id, cwd, project_id, title, model, provider, cli_version, git_branch, source_path, started_at, updated_at, ingested_at`. |
| `agent_turns` | One row per assistant turn with usage. FK to `agent_sessions(id)`, unique on `(session_id, seq)`. Columns: `seq, occurred_at, model, provider, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, tool_calls, finish_reason`. |
| `agent_sources` | Ingest bookkeeping, one row per source file/DB. Forward-only cursors: `last_offset, last_mtime, last_native_id`. |
| `agent_settings` | Per-agent enable/disable toggle plus detection metadata. |
| `todos.agent` / `todos.agent_session_id` | Attribution columns on the existing `todos` table. |

### Scanner architecture (`app/agent/usage/`)

```
app/agent/usage/
├── types.py             # SessionRow / TurnRow dataclasses
├── jsonl_reader.py      # Forward-only JSONL tailer with rotation detection
├── db.py                # Write path (BEGIN IMMEDIATE transactions)
├── ingest.py            # Orchestrator; serialized via asyncio.Lock
└── scanners/
    ├── copilot.py
    ├── claude_code.py
    ├── codex.py
    └── opencode.py
```

- **Sole writer**: the Python backend is the only writer for `agent_sessions` / `agent_turns` / `agent_sources` / `agent_settings`. The CLI treats these tables as read-only.
- **Forward-only ingest**: the first scan of a source emits metadata-only `SessionRow`s and pins cursors to EOF — no historical backfill of turns.
- **Crash-safe tailing**: JSONL scanners advance `last_offset` only to the last complete `\n` boundary (safe against partial writes) and detect rotation when `size < last_offset`.
- **Concurrency**: each scan is wrapped in `BEGIN IMMEDIATE`; `ingest.py` serializes scans via an `asyncio.Lock`.
- **OpenCode `cost` is dropped** on purpose — taskbean policy is to persist metadata + token counts only.

### Attribution (`cli/src/data/attribution.js`)

`bean add` resolves the agent + session id with a 4-tier precedence:

1. Explicit flags: `--agent=<name> --session-id=<native>`
2. `TASKBEAN_AGENT` + `TASKBEAN_NATIVE_SESSION_ID` env vars (preferred for skill wrappers)
3. Vendor env vars: `CLAUDECODE`/`CLAUDE_SESSION_ID`, `CODEX_SESSION_ID`, `OPENCODE_SESSION`, `COPILOT_CLI_SESSION_ID`
4. CWD + ±30 min heuristic against `agent_sessions`

Ambiguous signals return `null` — never "most recent". Missing attribution is logged and the task is still created without an agent.

### HTTP API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/agent-usage?period=today\|week\|month\|all&agents=copilot,claude-code` | Canonical multi-agent usage endpoint. |
| `GET /api/agent-usage/detection` | Per-agent installation + detection status. |
| `POST /api/agent-usage/settings/{agent}` body `{enabled: bool}` | Toggle per-agent tracking. |
| `GET /api/copilot-usage` | Back-compat shim. Prefer `/api/agent-usage`. |

### Privacy posture

Only **metadata** (session ids, timestamps, model/provider, cwd, git branch) and **aggregate token counts** are persisted. Message bodies, prompts, code blocks, and tool outputs are never copied into taskbean's DB.

### UI surface

- Usage panel renamed from "Copilot usage" → **"Usage"**, with agent filter chips.
- **Settings → Agents** section shows detection status and a per-agent enable toggle.
- Task detail shows a **"Source"** card when `todos.agent` is set.

### `bean report`

Reports now include a `## Usage` section (Markdown) / `usage` key (JSON) with per-agent sessions / turns / tokens / tool calls.
