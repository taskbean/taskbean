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
- 16 commands in `cli/src/commands/`
- SQLite access in `cli/src/data/store.js`
- Tests: `node --test cli/src/**/*.test.js`
- Install scripts: `cli/scripts/install.sh`, `cli/scripts/install.ps1`
- npm package name: `taskbean`

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

Single-file SPA in `public/index.html` (~4600 lines). No build step, no bundler. Vanilla JS, CSS custom properties for theming (dark-roast/latte/espresso/black-coffee), Lucide icons via CDN, `fast-json-patch` for AG-UI state deltas. PWA support via `sw.js` and `manifest.json`.

The telemetry panel has 4 tabs: **Events** (with filter chips + search), **Metrics** (sparkline cards), **Traces** (native waterfall via `/api/traces` Jaeger proxy), **Logs** (severity-filtered log records).

Chat submission uses `handleSend()` triggered by Enter key on `#chatInput` textarea — there is no submit button.

## Build & Run

### Python backend (primary)

```bash
cd app/agent
pip install -r requirements.txt
python main.py                    # starts on :2326, auto-starts Jaeger
```

### Node.js backend (legacy)

```bash
cd app
npm install
node server.js                    # starts on :2326, auto-starts Jaeger
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
npx playwright test                                    # all specs (17 files)
npx playwright test tests/smoke.spec.js                # single spec
npx playwright test -g "page loads"                    # single test by title
npx playwright test --project=smoke                    # smoke project only
```

Requires the server running on `:2326`. Config uses 3 projects with dependencies: `smoke` runs first, then `features` and `model-tests` run after smoke passes. Runs in Edge (`channel: 'msedge'`), records trace/video on failure.

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
