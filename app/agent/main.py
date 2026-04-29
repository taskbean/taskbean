"""FastAPI application — replaces server.js with Python backend.

Endpoints mirror the original Node.js server:
  GET  /api/health
  GET  /api/models
  POST /api/models/switch      (SSE)
  GET  /api/todos
  GET  /api/todos/overdue
  PATCH /api/todos/:id
  DELETE /api/todos/:id
  GET  /api/projects
  GET  /api/projects/tasks
  POST /api/projects/track
  GET  /api/fs/roots
  GET  /api/fs/browse
  GET  /api/copilot-usage
  GET  /api/task-detail/:id
  GET  /api/task-detail/:id/export
  GET  /api/templates
  POST /api/templates/activate
  POST /api/templates/deactivate
  GET  /api/hardware/eps
  GET  /api/port-info
  POST /api/port
  POST /api/suggest
  POST /api/upload
  POST /api/extract            (SSE)
  POST /api/transcribe
  POST /api/process-speech
  POST /api/test-notification
  GET  /api/telemetry/snapshot
  GET  /api/telemetry/stream   (SSE)
  POST /api/command            (AG-UI SSE — replaces custom SSE)
"""

from __future__ import annotations
import asyncio
import copy
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from pydantic import BaseModel, StrictBool

from opentelemetry import trace

import telemetry as telem
import state as state_mod
import app_config
import hardware as hw_mod
import shutil
import recommender
from __version__ import __version__ as APP_VERSION
from agent import (
    MODEL_ID, SERVICE_BASE_URL, MODEL_CONTEXT,
    foundry_ready, model_ready, startup_error,
    initialize_foundry, shutdown_foundry,
    get_fl_manager,
)
import agent as agent_mod
from agent import refresh_agent_instructions
from notifications import reminder_scheduler, send_notification
from context import count_tokens, get_input_budget, truncate_to_budget, split_into_chunks

# ── Bootstrap ─────────────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _ensure_jaeger() -> None:
    """Start the Jaeger container via docker compose if Docker is available.

    The compose file references ``jaegertracing/jaeger:2.17.0`` (Jaeger v2
    all-in-one with OTLP-native ingestion).
    """
    compose_file = Path(__file__).parent.parent / "docker-compose.yml"
    if not compose_file.exists():
        return
    try:
        result = subprocess.run(
            ["docker", "compose", "up", "-d"],
            cwd=str(compose_file.parent),
            capture_output=True,
            timeout=15,
        )
        if result.returncode == 0:
            logging.getLogger(__name__).info("Jaeger container started via docker compose")
        else:
            logging.getLogger(__name__).warning(
                "Jaeger container may not have started (exit %d): %s",
                result.returncode,
                result.stderr.decode(errors="replace")[:200],
            )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as e:
        logging.getLogger(__name__).info("Jaeger auto-start skipped (%s) — traces will buffer until collector is reachable", e)


# Start Jaeger BEFORE init_otel so the TCP probe finds the OTLP endpoint.
_ensure_jaeger()
telem.init_otel()
app_config.load()


def _register_protocol_handler() -> None:
    """Best-effort registration of the taskbean:// protocol handler in the
    Windows registry (HKCU — no admin required). Idempotent."""
    if sys.platform != "win32":
        return
    try:
        launch_ps1 = str(Path(__file__).parent.parent / "launch.ps1")
        cmd_value = f'powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "{launch_ps1}" "%1"'
        ps_script = (
            "New-Item -Path 'HKCU:\\Software\\Classes\\taskbean' -Force | Out-Null; "
            "Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\taskbean' -Name '(Default)' -Value 'URL:TaskBean Protocol'; "
            "New-ItemProperty -Path 'HKCU:\\Software\\Classes\\taskbean' -Name 'URL Protocol' -Value '' -Force | Out-Null; "
            "New-Item -Path 'HKCU:\\Software\\Classes\\taskbean\\shell\\open\\command' -Force | Out-Null; "
            f"Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\taskbean\\shell\\open\\command' -Name '(Default)' -Value '{cmd_value}'"
        )
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True, timeout=10, text=True,
        )
        logging.getLogger(__name__).info("taskbean:// protocol handler registered")
    except Exception as e:
        logging.getLogger(__name__).warning("Protocol handler registration failed (non-fatal): %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage startup tasks. All tasks run in the background so the server
    starts responding immediately while Foundry initialises."""
    # Register taskbean:// protocol so the PWA can restart the server
    _register_protocol_handler()

    # Load persisted state from SQLite so chat-created todos survive restarts
    try:
        from persistence import load_todos, load_templates
        db_todos = load_todos()
        if db_todos:
            state_mod.todos.extend(db_todos)
            logger.info("Loaded %d todos from SQLite", len(db_todos))
        db_templates = load_templates()
        if db_templates:
            state_mod.recurring_templates.extend(db_templates)
            logger.info("Loaded %d templates from SQLite", len(db_templates))
    except Exception as e:
        logger.warning("Failed to load persisted state: %s", e)

    # Resolve startup model: env var > user preference > SDK default
    startup_model = os.environ.get("FOUNDRY_MODEL") or app_config.preferred_model()
    preferred_device = os.environ.get("FOUNDRY_DEVICE") or app_config.preferred_device()
    asyncio.create_task(initialize_foundry(startup_model, preferred_device))
    asyncio.create_task(reminder_scheduler())
    # Hardware detection is run lazily on the first GET /api/config request.
    # Running WMI/PowerShell queries at startup contends with NPU inference.

    async def _delayed_health():
        await asyncio.sleep(0.5)
        telem._push_event({"id": telem._next_seq(), "ts": telem._now_iso(), "type": "health.snapshot", **_health_data()})

    asyncio.create_task(_delayed_health())
    asyncio.create_task(_metric_sampler())
    asyncio.create_task(_npu_usage_sampler())
    asyncio.create_task(_background_speech_warmup())
    yield  # server is running
    await shutdown_foundry()


async def _background_speech_warmup() -> None:
    """Warm Whisper after Foundry is ready, if the user's engine prefers it.

    Eliminates the silent multi-second pause on first mic press. Live model
    (Nemotron) is *not* warmed here — it's larger and only useful if the
    user explicitly opts into the beta tier."""
    try:
        for _ in range(120):  # up to 60s
            if agent_mod.foundry_ready:
                break
            await asyncio.sleep(0.5)
        if not agent_mod.foundry_ready:
            return
        speech_cfg = app_config.get("speech") or {}
        engine = (speech_cfg.get("engine") or "auto").lower()
        if engine in ("auto", "whisper"):
            try:
                await _get_whisper_client()
                logger.info("Background Whisper warmup complete")
            except Exception as exc:
                logger.warning("Background Whisper warmup failed (non-fatal): %s", exc)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.debug("Background warmup task crashed: %s", exc)


app = FastAPI(title="Foundry Todo Agent", lifespan=lifespan)
telem.instrument_fastapi(app)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response as StarletteResponse

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        # Prevent browser from caching API responses (avoids stale HTML from SPA fallback)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        else:
            # CSP for HTML pages only — API responses (JSON) don't need it
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; "
                "script-src 'self' 'unsafe-inline'; "
                "script-src-attr 'unsafe-inline'; "
                "style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data:; "
                "connect-src 'self' https://unpkg.com https://api.open-meteo.com http://localhost:*; "
                "frame-src 'self' http://localhost:*; "
                "frame-ancestors 'none'"
            )
        return response

app.add_middleware(SecurityHeadersMiddleware)

# Serve the existing frontendfrom ../public
_PUBLIC = Path(__file__).parent.parent / "public"

# ── AG-UI command endpoint ─────────────────────────────────────────────────────

from agent_framework_ag_ui import AGUIRequest, add_agent_framework_fastapi_endpoint

# Agent is built inside initialize_foundry() after the model loads.
# Do NOT call build_agent() here — MODEL_ID and SERVICE_BASE_URL are still
# empty at module-load time, which would create a broken agent pointed at
# an invalid URL (http://127.0.0.1:0/v1).

# Use the DynamicAgentProxy so model switches take effect without re-registration.
add_agent_framework_fastapi_endpoint(
    app,
    agent_mod.agent_proxy,
    "/api/command",
    default_state={
        "todos": state_mod.todos,
        "recurringTemplates": state_mod.recurring_templates,
    },
)


_instructions_lock = asyncio.Lock()


@app.middleware("http")
async def refresh_instructions_middleware(request: Request, call_next):
    """Pre-process /api/command requests:
    1. Refresh agent instructions (current time + todo list)
    2. Truncate [Task Context] system messages to fit model context window

    Uses a lock so concurrent requests cannot interleave instruction
    mutations on the shared singleton.
    """
    if request.url.path == "/api/command":
        async with _instructions_lock:
            refresh_agent_instructions()

        # Only intercept JSON requests — skip streaming/multipart content
        content_type = request.headers.get("content-type", "")
        if "application/json" in content_type:
            body = await request.body()
            if b"[Task Context]" in body:
                try:
                    data = json.loads(body)
                    msgs = data.get("messages", [])
                    if msgs and msgs[0].get("role") == "system" and "[Task Context]" in (msgs[0].get("content") or ""):
                        max_in = agent_mod.MODEL_CONTEXT.get("maxInputTokens")
                        max_out = agent_mod.MODEL_CONTEXT.get("maxOutputTokens")
                        budget = get_input_budget(max_in, max_out)
                        if budget:
                            ctx_budget = int(budget * 0.80)
                            original = msgs[0]["content"]
                            truncated, was_truncated = truncate_to_budget(original, ctx_budget)
                            if was_truncated:
                                msgs[0]["content"] = truncated
                                logger.info(
                                    "Task context truncated: %d → %d tokens (budget=%d)",
                                    count_tokens(original), count_tokens(truncated), ctx_budget,
                                )
                                request._body = json.dumps(data).encode()
                except (json.JSONDecodeError, KeyError):
                    pass  # let the endpoint handle malformed requests

    return await call_next(request)

async def _metric_sampler() -> None:
    _last_key: str = ""
    while True:
        await asyncio.sleep(30)
        current = {
            "todosActive": sum(1 for t in state_mod.todos if not t["completed"]),
        }
        key = json.dumps(current, sort_keys=True)
        if key == _last_key:
            continue
        _last_key = key
        telem._push_event({
            "id": telem._next_seq(), "ts": telem._now_iso(), "type": "metric.sample",
            **current,
            "uptimeMs": int(time.time() * 1000) - telem.SERVER_START,
        })


# ── NPU utilization sampler (background PDH polling) ─────────────────────────

_npu_usage_percent: float = 0.0
# PDH function calls are not documented as thread-safe
# (https://learn.microsoft.com/en-us/windows/win32/perfctrs/thread-safety).
# The sampler awaits asyncio.sleep(3) between iterations and each
# _sample_npu_pdh call is well under 100 ms, so overlap is implausible —
# but a module-level lock around the asyncio.to_thread call is cheap
# insurance against future refactors that might add a second PDH caller.
_pdh_lock: "asyncio.Lock | None" = None


async def _npu_usage_sampler() -> None:
    """Sample Windows PDH 'GPU Engine' counters filtered to NPU LUID every 3 s.

    Uses pywin32's in-process win32pdh bindings so each tick is microseconds
    instead of the ~200-500 ms cost of spawning powershell.exe (the previous
    implementation spawned ~1200 processes/hour). PDH counters are
    re-expanded each iteration so new process IDs (each Foundry-loaded model
    appears as a new pid_X instance) get picked up automatically.

    Localization caveat: the counter path uses the English name "GPU Engine".
    On non-English Windows installations (French "Moteur GPU", German
    "GPU-Engine", etc.) ExpandCounterPath returns no matches and the
    sampler silently reports 0%. pywin32 does not expose
    PdhAddEnglishCounter; a future fix would resolve the localized name
    via PdhLookupPerfNameByIndex (English index 1594 for GPU Engine).
    """
    global _npu_usage_percent, _pdh_lock
    # Wait for hardware detection to complete (lazy, runs on first /api/config)
    await asyncio.sleep(5)
    hw = hw_mod.detect_hardware()
    if not hw.npu or not hw.npu.luid:
        logger.info("NPU LUID not available — NPU usage sampler disabled")
        return

    try:
        import win32pdh  # type: ignore[import-not-found]
    except ImportError as exc:
        logger.warning("pywin32 not installed (%s) — NPU usage sampler disabled", exc)
        return

    if _pdh_lock is None:
        _pdh_lock = asyncio.Lock()

    luid = hw.npu.luid
    counter_filter = rf"\GPU Engine(pid_*_luid_{luid}*)\Utilization Percentage"
    logger.info("NPU usage sampler started (in-process PDH) for LUID %s", luid)

    while True:
        try:
            async with _pdh_lock:
                _npu_usage_percent = await asyncio.to_thread(_sample_npu_pdh, win32pdh, counter_filter)
        except Exception as exc:
            logger.debug("NPU sampler iteration failed (%s: %s)", type(exc).__name__, exc)
            _npu_usage_percent = 0.0
        await asyncio.sleep(3)


def _sample_npu_pdh(win32pdh, counter_filter: str) -> float:
    """One PDH sampling iteration. Returns aggregate NPU utilization %.

    Pure synchronous; called via asyncio.to_thread from _npu_usage_sampler.
    Opens a fresh query each iteration so dynamic process IDs (Foundry
    Local spawns a new process per loaded model) and engine-instance
    changes are picked up without manual cache invalidation. PDH calls
    are microseconds each, so the open/close-per-iteration cost is
    negligible compared to the previous powershell.exe-spawn-per-iteration.
    """
    try:
        paths = win32pdh.ExpandCounterPath(counter_filter)
    except Exception:
        paths = []
    if not paths:
        return 0.0

    query = win32pdh.OpenQuery()
    counters = []
    try:
        for p in paths:
            try:
                counters.append(win32pdh.AddCounter(query, p))
            except Exception:
                # Counter path may have disappeared between Expand and Add
                # — typical for short-lived processes. Skip and continue.
                pass
        if not counters:
            return 0.0
        # Utilization Percentage is a rate counter — needs two samples
        # to produce a value. CollectQueryData calls are microseconds.
        win32pdh.CollectQueryData(query)
        # ~50 ms is the conventional minimum for rate-counter delta sampling;
        # we already sleep 3 s between iterations so this only adds delay
        # within a single iteration's thread, not the asyncio loop.
        time.sleep(0.05)
        win32pdh.CollectQueryData(query)
        total = 0.0
        for c in counters:
            try:
                _, val = win32pdh.GetFormattedCounterValue(c, win32pdh.PDH_FMT_DOUBLE)
                total += val
            except Exception:
                pass
        return min(100.0, max(0.0, round(total, 1)))
    finally:
        for c in counters:
            try: win32pdh.RemoveCounter(c)
            except Exception: pass
        try: win32pdh.CloseQuery(query)
        except Exception: pass


# ── Health ────────────────────────────────────────────────────────────────────

def _health_data() -> dict[str, Any]:
    whisper_loaded = _whisper_model is not None
    whisper_device = _device_from_model_id(_whisper_model.id) if whisper_loaded else None
    whisper_alias = _whisper_loaded_alias if whisper_loaded else _get_whisper_alias()
    live_loaded = _live_model is not None
    live_device = _device_from_model_id(_live_model.id) if live_loaded else None
    # Friendly model alias (e.g. "qwen3-0.6b") + execution device tag for
    # the composer pill / status bar — the full MODEL_ID is for API calls,
    # the alias is for display.
    model_id = agent_mod.MODEL_ID
    model_alias = agent_mod.MODEL_ALIAS or model_id
    if model_id:
        _id_lc = model_id.lower()
        if "npu" in _id_lc or "vitis" in _id_lc:
            model_device = "NPU"
        elif "gpu" in _id_lc or "migraphx" in _id_lc:
            model_device = "GPU"
        else:
            model_device = "CPU"
    else:
        model_device = None
    return {
        "type": "health.snapshot",
        "model": model_id,
        "modelAlias": model_alias,
        "modelDevice": model_device,
        "serviceUrl": agent_mod.SERVICE_BASE_URL,
        "foundryReady": agent_mod.foundry_ready,
        "modelReady": agent_mod.model_ready,
        "startupError": agent_mod.startup_error,
        "mcpAvailable": _markitdown_available(),
        "uptimeMs": int(time.time() * 1000) - telem.SERVER_START,
        # Voice transcription models — both lazy-loaded on first use. The
        # status bar surfaces each model's execution device chip alongside
        # the chat model's. Whisper is the batch transcription model;
        # the live model (Nemotron streaming) powers /api/transcribe/live.
        "whisperLoaded": whisper_loaded,
        "whisperDevice": whisper_device,
        "whisperAlias": whisper_alias,
        "liveModelLoaded": live_loaded,
        "liveModelDevice": live_device,
        "liveTierAvailable": _check_live_tier_available(),
    }


# Tracks whether psutil.cpu_percent has been called at least once in this
# process — the first call returns 0.0 unless given an explicit interval.
_psutil_warmed_up = False


def _hardware_snapshot() -> dict[str, Any]:
    """Live hardware snapshot with CPU/RAM/NPU usage."""
    hw = hw_mod.detect_hardware()
    hw_dict = hw.to_dict()
    # Enrich with live metrics. Catch *any* psutil failure (not just
    # ImportError) — empirically the module's internal state can get
    # corrupted on long-running uvicorn workers (probably Foundry SDK FFI
    # interactions), at which point a previously-working psutil starts
    # raising or returning bad data. Log and gracefully degrade so the
    # status bar stops at "0%/0GB" instead of returning HTTP 500.
    try:
        import psutil
        # interval=None returns the percentage since the previous call —
        # the very first call after process start returns 0.0 because there
        # is no previous reference. Use a tiny 0.05 s sampling window for
        # the first call to avoid the cold-start zero; subsequent calls
        # return immediately because psutil keeps its own per-process
        # baseline.
        global _psutil_warmed_up
        cpu_pct = psutil.cpu_percent(interval=None if _psutil_warmed_up else 0.05)
        _psutil_warmed_up = True
        hw_dict["cpu"]["usagePercent"] = cpu_pct
        mem = psutil.virtual_memory()
        hw_dict["ram"] = {
            "totalGb": round(mem.total / (1024 ** 3), 1),
            "usedGb": round(mem.used / (1024 ** 3), 1),
            "freeGb": round(mem.available / (1024 ** 3), 1),
            "usagePercent": round(mem.percent, 1),
        }
        # Backfill cpu.ramGb when hardware.py's wmic-based detector failed
        # (wmic was removed in Windows 11 24H2+). psutil's value is the
        # ground truth for live RAM totals anyway.
        if not hw_dict["cpu"].get("ramGb"):
            hw_dict["cpu"]["ramGb"] = round(mem.total / (1024 ** 3), 1)
    except Exception as exc:
        logger.warning("psutil snapshot failed (%s: %s) — falling back to static values", type(exc).__name__, exc)
        hw_dict["cpu"]["usagePercent"] = 0
        total = hw.ram_gb
        hw_dict["ram"] = {"totalGb": round(total, 1), "usedGb": 0, "freeGb": round(total, 1), "usagePercent": 0}
    # NPU usage from background sampler
    if hw_dict.get("npu"):
        hw_dict["npu"]["usagePercent"] = _npu_usage_percent
    return hw_dict


@app.get("/api/health")
async def health() -> dict:
    return _health_data()


@app.get("/api/launch-errors")
async def launch_errors(limit: int = 20) -> dict:
    """Returns a rolling history of launcher errors written by app/launch.ps1.

    The launcher appends a JSON line to %TEMP%\\taskbean-launch.log whenever
    Write-LaunchError fires (missing prereqs, model never reached ready,
    venv could not be created, etc.). Entries are capped at 50 in the log
    file itself; this endpoint returns the most recent `limit` entries.

    Successful launches do NOT clear the log — it is a diagnostic history,
    surfaced in the PWA's stats-for-nerds Logs tab. Returns an empty list
    when no log file exists yet.
    """
    try:
        log_path = Path(os.environ.get("TEMP", "")) / "taskbean-launch.log"
    except Exception:
        return {"entries": []}
    if not log_path.is_file():
        return {"entries": []}
    try:
        # PowerShell's `Set-Content -Encoding UTF8` adds a BOM on PS 5.1; use
        # utf-8-sig so we tolerate either BOM or no-BOM writers.
        raw = log_path.read_text(encoding="utf-8-sig")
    except Exception as exc:
        return {"entries": [], "readError": str(exc)}
    entries: list[dict] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except Exception:
            # Skip malformed lines rather than failing the whole response.
            continue
    # Most recent first, capped at `limit`.
    entries.reverse()
    capped = max(1, min(limit, 50))
    return {"entries": entries[:capped]}


# ── Single-shot inference helper ──────────────────────────────────────────────

_THINK_RE = re.compile(r"<think>[\s\S]*?</think>")


def _strip_reasoning_tags(text: str) -> str:
    """Remove <think>…</think> reasoning blocks that some models emit."""
    return _THINK_RE.sub("", text).strip()


async def _smoke_test_inference(model_id: str, timeout_s: float = 90.0) -> str | None:
    """Verify a model can serve an agent-shaped inference request.

    Used by /api/models/switch's _commit_switch to catch Foundry-side
    failures (model loaded but ONNX session broken, EP missing, context
    too large, runtime crashes on tool-call payloads, etc.) at switch time
    rather than at chat time.

    The probe sends the **exact** payload shape the real agent will send:
    the full agent instructions (with embedded todo list) plus all
    ``ALL_TOOLS`` definitions. This is critical because Foundry NPU
    runtimes can crash on full agent payloads even when smaller probes
    succeed (Foundry-Local#506). A "minimal" smoke test would let those
    models through and the first real chat would crash the server.

    Args:
        model_id: Full Foundry model variant ID, e.g.
            "qwen2.5-coder-0.5b-instruct-generic-cpu:4".
        timeout_s: Total deadline for the smoke test. Default is generous
            because NPU loads a fresh ONNX session on first inference and
            larger models can take 60+ seconds for even a short response.

    Returns:
        ``None`` if the smoke test succeeded.
        Otherwise an error message describing why it failed.
    """
    if not agent_mod.SERVICE_BASE_URL:
        return "Smoke test failed: Foundry web service URL is not set"

    url = f"{agent_mod.SERVICE_BASE_URL}/v1/chat/completions"

    # Build the agent-shaped probe. We use the LIVE agent instructions and
    # the full ``ALL_TOOLS`` list — anything smaller risks letting through
    # an NPU model that will crash on the first real chat.
    try:
        from tools import ALL_TOOLS as _all_tools
        from agent_framework_openai._chat_completion_client import RawOpenAIChatCompletionClient  # noqa: F401

        # Reuse agent-framework's tool serialization so the wire shape matches
        # exactly what the real chat will send.
        probe_tools = _serialize_tools_for_smoke(_all_tools)
        if not probe_tools:
            # _serialize_tools_for_smoke returned empty — every tool failed to
            # serialize. Fall through to the warning + fallback path.
            raise RuntimeError("No tools could be serialized from ALL_TOOLS")
    except Exception as exc:
        # Fallback to a 1-tool probe so the smoke test can still run if the
        # tool import chain is broken. Log a warning so this doesn't silently
        # mask real bugs — a broken tool import is itself a critical defect
        # the user should investigate.
        logger.warning(
            "Failed to serialize ALL_TOOLS for smoke test (%s: %s) — "
            "falling back to a 1-tool probe. The smoke test will pass on "
            "models that would actually fail with the real %d-tool payload. "
            "Investigate the import error before relying on smoke results.",
            type(exc).__name__, exc,
            len(getattr(__import__('tools'), 'ALL_TOOLS', []) or []),
        )
        probe_tools = _agent_smoke_tools_fallback()

    instructions = agent_mod._build_instructions() if hasattr(agent_mod, "_build_instructions") else (
        "You are a todo list assistant. Reply with one short word."
    )

    body = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": instructions},
            {"role": "user", "content": "ok"},
        ],
        "tools": probe_tools,
        "tool_choice": "auto",
        "max_tokens": 16,
        "stream": False,
    }
    # Qwen3 thinking-mode suppression — see agent.qwen3_extra_body /
    # prepend_qwen3_no_think_message. The /no_think system message is the
    # primary mechanism (works regardless of whether the runtime forwards
    # chat_template_kwargs); extra_body is belt-and-suspenders.
    body["messages"] = agent_mod.prepend_qwen3_no_think_message(body["messages"], model_id)
    extra = agent_mod.qwen3_extra_body(model_id)
    if extra:
        body.update(extra)
    # First inference on a freshly-loaded model can be substantially slower
    # than steady-state because Foundry's ONNX EP JITs kernels for the
    # specific input shapes. Give Qwen3 (and any other freshly-loaded model)
    # a generous budget; only models that genuinely can't serve the agent
    # payload will fail.
    if agent_mod.is_qwen3_model(model_id) and timeout_s < 180:
        timeout_s = 180.0
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5, read=timeout_s, write=5, pool=5)
        ) as client:
            resp = await client.post(url, json=body)
        if resp.status_code != 200:
            body_preview = (resp.text or "")[:200]
            return (
                f"Smoke test failed: HTTP {resp.status_code} from "
                f"{model_id}. Body: {body_preview!r}"
            )
        # Foundry occasionally returns 200 with an empty/error JSON.
        try:
            data = resp.json()
        except ValueError:
            return f"Smoke test failed: non-JSON response from {model_id}"
        if not data.get("choices"):
            return f"Smoke test failed: no choices in response from {model_id}"
    except httpx.TimeoutException:
        return f"Smoke test failed: timed out after {timeout_s}s on {model_id}"
    except (httpx.RemoteProtocolError, httpx.ReadError, httpx.ConnectError) as exc:
        # Foundry crashed mid-request — common NPU failure mode (#506).
        # Surface a clear message so the user knows to switch back to a
        # CPU/GPU model rather than blaming our wrapper.
        return (
            f"Smoke test failed: Foundry closed the connection on {model_id}. "
            f"This usually means the model can't handle agent-shaped "
            f"requests (system prompt + tools). NPU models are particularly "
            f"prone to this — see Foundry-Local#506. Underlying error: "
            f"{type(exc).__name__}: {exc}"
        )
    except Exception as exc:
        return f"Smoke test failed: {type(exc).__name__}: {exc}"
    return None


def _serialize_tools_for_smoke(tools: list) -> list[dict]:
    """Convert agent-framework ``@tool``-decorated callables into the
    OpenAI ``tools=[...]`` wire shape the smoke test sends. Mirrors the
    serialization agent-framework's ``OpenAIChatCompletionClient`` does
    internally so we don't introduce divergence between the smoke probe
    and the real chat payload.
    """
    out: list[dict] = []
    for t in tools:
        # FunctionTool exposes to_json_schema_spec() which returns the
        # exact wire shape agent-framework sends to the OpenAI client.
        spec = getattr(t, "to_json_schema_spec", None)
        if callable(spec):
            try:
                out.append(spec())
                continue
            except Exception:
                pass
        # Fallback: try to assemble manually
        name = getattr(t, "name", None) or getattr(t, "__name__", None)
        if not name:
            continue
        description = getattr(t, "description", "") or (getattr(t, "__doc__", "") or "")
        params_fn = getattr(t, "parameters", None)
        if callable(params_fn):
            try:
                params = params_fn()
            except Exception:
                params = {"type": "object", "properties": {}}
        else:
            params = {"type": "object", "properties": {}}
        out.append({
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": params,
            },
        })
    return out


def _agent_smoke_tools_fallback() -> list[dict]:
    """Fallback tool list if real ALL_TOOLS can't be loaded for any reason.

    Should never be hit in production — exists only so the smoke test can
    still run if the import chain breaks for some reason.
    """
    return [
        {
            "type": "function",
            "function": {
                "name": "add_task",
                "description": "Add a plain task or todo item.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string", "description": "Task title"},
                    },
                    "required": ["title"],
                },
            },
        },
    ]



async def _foundry_complete(system_prompt: str, user_message: str) -> str:
    """Single-shot LLM inference via the Foundry Local web service.

    Uses streaming because that's what worked when this code was written.
    The non-streaming path also works for CPU/GPU models (verified
    2026-04-26); NPU non-streaming is unverified. The AG-UI agent path
    uses a non-streaming wrapper (see ``_NormalizingChatClient`` in
    agent.py) to work around Foundry-Local#422; this helper is independent
    of that and stays on streaming until we have time to switch to the
    same wrapped pattern.

    Returns the accumulated text response.
    """
    if not agent_mod.model_ready:
        raise HTTPException(status_code=503, detail="Model not ready")

    messages: list[dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_message})

    max_out = agent_mod.MODEL_CONTEXT.get("maxOutputTokens")
    body: dict[str, Any] = {
        "model": agent_mod.MODEL_ID,
        "messages": messages,
        "stream": True,
        "max_tokens": min(2000, max_out) if max_out else 2000,
        "temperature": 0.7,
    }
    # Qwen3 thinking-mode suppression — same dual approach as the smoke test.
    body["messages"] = agent_mod.prepend_qwen3_no_think_message(body["messages"], agent_mod.MODEL_ID)
    extra = agent_mod.qwen3_extra_body(agent_mod.MODEL_ID)
    if extra:
        body.update(extra)

    span = trace.get_current_span()
    span.set_attribute("gen_ai.system", "foundry-local")
    span.set_attribute("gen_ai.request.model", agent_mod.MODEL_ID)
    span.set_attribute("gen_ai.request.max_tokens", body["max_tokens"])
    span.set_attribute("gen_ai.request.mode", "streaming")
    span.set_attribute("gen_ai.input_length", sum(len(m.get("content", "")) for m in messages))
    _fc_start = time.time()

    url = f"{agent_mod.SERVICE_BASE_URL}/v1/chat/completions"
    headers = {"Accept": "text/event-stream"}
    accumulated = ""
    usage: dict[str, Any] = {}
    chunk: dict[str, Any] = {}

    async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10, read=300, write=10, pool=10)) as client:
        async with client.stream("POST", url, json=body, headers=headers) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                # Capture usage from the final chunk (Foundry Local includes it)
                if chunk.get("usage"):
                    usage = chunk["usage"]
                delta = chunk.get("choices", [{}])[0].get("delta", {}).get("content")
                if delta:
                    accumulated += delta

    _fc_elapsed = int((time.time() - _fc_start) * 1000)
    span.set_attribute("gen_ai.response.duration_ms", _fc_elapsed)
    span.set_attribute("gen_ai.usage.input_tokens", usage.get("prompt_tokens"))
    span.set_attribute("gen_ai.usage.output_tokens", usage.get("completion_tokens"))
    finish_reason = chunk.get("choices", [{}])[0].get("finish_reason")
    if finish_reason:
        span.set_attribute("gen_ai.response.finish_reason", finish_reason)

    return _strip_reasoning_tags(accumulated)


# ── Version / build info ──────────────────────────────────────────────────────

_STARTED_AT = datetime.now(timezone.utc).isoformat()


# Memoized: the CLI binary and git SHA don't change during the server's
# lifetime. Sentinel object identity is used to distinguish "not yet resolved"
# from "resolved to None".
_UNSET = object()
_CLI_VERSION_CACHE: object = _UNSET
_GIT_SHA_CACHE: object = _UNSET


def _resolve_cli_version() -> str | None:
    """Try to read the installed `bean` CLI version; return None on any failure."""
    global _CLI_VERSION_CACHE
    if _CLI_VERSION_CACHE is not _UNSET:
        return _CLI_VERSION_CACHE  # type: ignore[return-value]
    try:
        exe = shutil.which("bean") or shutil.which("taskbean")
        if not exe:
            _CLI_VERSION_CACHE = None
            return None
        result = subprocess.run(
            [exe, "--version"],
            capture_output=True, text=True, timeout=3, check=False,
        )
        out = (result.stdout or result.stderr or "").strip()
        _CLI_VERSION_CACHE = out or None
        return _CLI_VERSION_CACHE  # type: ignore[return-value]
    except Exception:
        _CLI_VERSION_CACHE = None
        return None


def _resolve_git_sha() -> str | None:
    global _GIT_SHA_CACHE
    if _GIT_SHA_CACHE is not _UNSET:
        return _GIT_SHA_CACHE  # type: ignore[return-value]
    env_sha = os.environ.get("GIT_SHA")
    if env_sha:
        _GIT_SHA_CACHE = env_sha.strip()
        return _GIT_SHA_CACHE  # type: ignore[return-value]
    try:
        repo_root = Path(__file__).resolve().parents[2]
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(repo_root),
            capture_output=True, text=True, timeout=2, check=False,
        )
        sha = (result.stdout or "").strip()
        _GIT_SHA_CACHE = sha or None
        return _GIT_SHA_CACHE  # type: ignore[return-value]
    except Exception:
        _GIT_SHA_CACHE = None
        return None


@app.get("/api/version")
async def version() -> dict:
    return {
        "app": APP_VERSION,
        "cli": _resolve_cli_version(),
        "git_sha": _resolve_git_sha(),
        "started_at": _STARTED_AT,
    }


@app.get("/api/skill-status")
async def skill_status() -> dict:
    """Report drift between the bundled SKILL.md and on-disk copies.

    Shells out to `bean update-skill --json` (read-only mode, no writes).
    Returns shape::

        {
          "available": true,
          "bundled_version": "0.5.0",
          "stale_count": 1,
          "fresh_count": 2,
          "present_count": 3,
          "on_disk": [{path, scope, state, version?}],
          "fix_command": "bean update-skill --apply"
        }

    On any failure (CLI not on PATH, parse error, timeout) returns
    ``{"available": false, "reason": "..."}`` so the frontend can hide the
    banner without surfacing scary errors during the demo.
    """
    exe = shutil.which("bean") or shutil.which("taskbean")
    if not exe:
        return {"available": False, "reason": "bean CLI not on PATH"}
    try:
        proc = await asyncio.to_thread(
            subprocess.run,
            [exe, "update-skill", "--json"],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except Exception as e:
        return {"available": False, "reason": f"exec failed: {e}"}
    raw = (proc.stdout or "").strip()
    if not raw:
        return {"available": False, "reason": "no output from bean update-skill --json"}
    try:
        data = json.loads(raw)
    except Exception as e:
        return {"available": False, "reason": f"json parse failed: {e}"}
    data["available"] = True
    data["fix_command"] = "bean update-skill --apply"
    return data


@app.get("/api/hardware")
async def hardware_snapshot() -> dict:
    return _hardware_snapshot()


@app.get("/api/hardware/eps")
async def hardware_eps() -> list:
    try:
        manager = get_fl_manager()
        eps = await asyncio.to_thread(manager.discover_eps)
        return eps
    except Exception:
        return []


# ── Model management ──────────────────────────────────────────────────────────

def _parse_model_catalog() -> list[dict]:
    """Build the model catalog using the new Foundry Local SDK, with CLI fallback."""
    try:
        manager = get_fl_manager()
        models = manager.catalog.list_models()
        result = []
        for m in models:
            info = m.info
            alias = info.alias or ""
            alias_lower = alias.lower()
            family = (
                "Qwen" if alias_lower.startswith("qwen")
                else "Phi" if alias_lower.startswith("phi")
                else "DeepSeek" if alias_lower.startswith("deepseek")
                else "Mistral" if alias_lower.startswith("mistral")
                else "Llama" if alias_lower.startswith("llama")
                else "Whisper" if alias_lower.startswith("whisper")
                else "Nemotron" if alias_lower.startswith("nemotron")
                else "Other"
            )
            param_match = re.search(r"[_-](\d+\.?\d*)\s*b\b", alias, re.I)
            device = info.runtime.device_type if info.runtime else None
            device_str = device.upper() if device else "CPU"
            # Modality split: "voice" for ASR / speech models, "chat" for
            # everything else. Source of truth is info.task (Foundry SDK
            # exposes HF-style task labels: text-generation / chat-completion
            # vs automatic-speech-recognition / speech-to-text). Fall back to
            # the alias prefix when info.task is missing or unrecognised so
            # offline catalog parsers still classify correctly.
            raw_task = (getattr(info, "task", None) or "").lower()
            voice_tasks = {"automatic-speech-recognition", "speech-to-text", "transcribe"}
            voice_alias_prefixes = ("whisper", "nemotron-speech", "moonshine", "wav2vec")
            if raw_task in voice_tasks or any(alias_lower.startswith(p) for p in voice_alias_prefixes):
                modality = "voice"
            else:
                modality = "chat"
            result.append({
                "alias": alias,
                "modelId": m.id,
                "device": device_str,
                "fileSizeGb": round(info.file_size_mb / 1024, 2) if info.file_size_mb else None,
                "paramBillions": float(param_match.group(1)) if param_match else None,
                "family": family,
                "modality": modality,
                "task": raw_task or None,
                "tasks": ["chat", "tools"] if info.supports_tool_calling else ["chat"],
                "toolCalling": bool(info.supports_tool_calling),
                "license": info.license or "",
                # Use the camelCase names the frontend / recommender already
                # read. The earlier "contextLength" key was effectively dead
                # (no consumer touched it), which made the model picker's
                # context filter and the context chip both invisible.
                "maxInputTokens": info.context_length,
                "maxOutputTokens": info.max_output_tokens,
            })
        return result
    except Exception as e:
        logger.warning("SDK catalog failed, falling back to CLI: %s", e)
        return _parse_model_catalog_cli()


def _parse_model_catalog_cli() -> list[dict]:
    """CLI fallback for when the SDK is unavailable."""
    try:
        raw = subprocess.run(
            "foundry model list", shell=True, capture_output=True, text=True, timeout=15
        ).stdout
    except Exception:
        return []

    models = []
    current_alias = ""
    for line in raw.splitlines():
        if re.match(r"^[-─\s]+$", line) or line.startswith("Alias"):
            continue
        trimmed = line.strip()
        if not trimmed:
            continue
        parts = re.split(r"\s{2,}", trimmed)
        if len(parts) < 5:
            continue
        maybe_alias, device, tasks, file_size, license_ = (parts + [""] * 5)[:5]
        model_id = parts[5].strip() if len(parts) > 5 else ""
        if maybe_alias:
            current_alias = maybe_alias

        device_norm = ("NPU" if "NPU" in device.upper()
                       else "GPU" if "GPU" in device.upper()
                       else "CPU" if "CPU" in device.upper()
                       else device)
        gb_match = re.search(r"([\d.]+)\s*GB", file_size, re.I)
        file_size_gb = float(gb_match.group(1)) if gb_match else None
        param_match = re.search(r"[_-](\d+\.?\d*)\s*b\b", current_alias, re.I)
        param_billions = float(param_match.group(1)) if param_match else None
        alias_lower = current_alias.lower()
        family = (
            "Qwen" if alias_lower.startswith("qwen")
            else "Phi" if alias_lower.startswith("phi")
            else "DeepSeek" if alias_lower.startswith("deepseek")
            else "Mistral" if alias_lower.startswith("mistral")
            else "Llama" if alias_lower.startswith("llama")
            else "Whisper" if alias_lower.startswith("whisper")
            else "Nemotron" if alias_lower.startswith("nemotron")
            else "Other"
        )
        # CLI fallback: classify modality by alias prefix (CLI doesn't expose task field).
        voice_alias_prefixes = ("whisper", "nemotron-speech", "moonshine", "wav2vec")
        modality = "voice" if any(alias_lower.startswith(p) for p in voice_alias_prefixes) else "chat"
        models.append({
            "alias": current_alias,
            "modelId": model_id,
            "device": device_norm,
            "fileSizeGb": file_size_gb,
            "paramBillions": param_billions,
            "family": family,
            "modality": modality,
            "task": None,
            "tasks": [t.strip() for t in tasks.split(",") if t.strip()],
            "toolCalling": "tools" in tasks.lower() or "tool" in tasks.lower(),
            "license": license_,
            # CLI fallback can't see context limits — leave them None so the
            # frontend's range filters and the recommender simply skip these
            # models for context-aware checks instead of hiding them.
            "maxInputTokens": None,
            "maxOutputTokens": None,
        })
    return models


_catalog_cache: list[dict] | None = None
_catalog_expiry: float = 0.0


def get_model_catalog() -> list[dict]:
    global _catalog_cache, _catalog_expiry
    if _catalog_cache and time.time() < _catalog_expiry:
        return _catalog_cache
    _catalog_cache = _parse_model_catalog()
    _catalog_expiry = time.time() + 60
    return _catalog_cache


@app.get("/api/models")
async def list_models() -> dict:
    catalog = get_model_catalog()
    cached_ids: set[str] = set()
    loaded_ids: set[str] = set()

    # New SDK gives us cached and loaded status via native FFI.
    try:
        manager = get_fl_manager()
        for m in await asyncio.to_thread(manager.catalog.get_cached_models):
            cached_ids.add(m.id)
        for m in await asyncio.to_thread(manager.catalog.get_loaded_models):
            loaded_ids.add(m.id)
    except Exception as e:
        logger.warning("SDK model status failed: %s", e)

    models = []
    for m in catalog:
        mid = m["modelId"]
        models.append({
            **m,
            "active": mid == agent_mod.MODEL_ID,
            "cached": mid in cached_ids,
            "loaded": mid in loaded_ids,
            # maxInputTokens and maxOutputTokens come from the catalog entry itself
            # (ModelInfo.context_length / ModelInfo.max_output_tokens via new SDK)
        })

    return {"active": agent_mod.MODEL_ID, "models": models}


# ── App config ────────────────────────────────────────────────────────────────

@app.get("/api/config")
async def get_config() -> dict:
    """Return current configuration and the detected hardware profile."""
    return {
        **app_config.all_settings(),
        "hardware": hw_mod.detect_hardware().to_dict(),
    }


class ScheduleBlock(BaseModel):
    start: str | None = None
    end: str | None = None
    days: list[str] | None = None
    enabled: bool | None = None


class ScheduleConfig(BaseModel):
    dnd: ScheduleBlock | None = None
    reminderHours: ScheduleBlock | None = None


class SpeechConfig(BaseModel):
    engine: str | None = None
    fallback: str | None = None
    micDevice: str | None = None
    whisperModel: str | None = None
    action: str | None = None


class ConfigPatch(BaseModel):
    modelPermission: str | None = None
    preferredDevice: str | None = None
    preferredModel: str | None = None
    runOnStartup: bool | None = None
    autoSelectIcon: bool | None = None
    timezone: str | None = None
    hideIncompatibleModels: bool | None = None
    toolCallOnly: bool | None = None
    schedule: ScheduleConfig | None = None
    speech: SpeechConfig | None = None


def _run_powershell(script: str, timeout: int = 15) -> subprocess.CompletedProcess:
    """Run a PowerShell command via -EncodedCommand to avoid quoting bugs.

    PowerShell's -EncodedCommand takes a base64-encoded UTF-16LE string,
    which sidesteps every shell-quoting trap (apostrophes in usernames,
    spaces in paths, embedded quotes, etc.) — the script bytes go through
    unmodified.
    """
    import base64
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        capture_output=True, timeout=timeout, text=True,
    )


def _legacy_shortcut_path() -> Path:
    """Path to the pre-P3 Startup-folder .lnk we migrate users away from."""
    startup_dir = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    return startup_dir / "TaskBean.lnk"


def _sync_startup_scheduled_task(enabled: bool) -> dict:
    """Create or remove a per-user Windows Scheduled Task for launch.ps1.

    Replaces the prior Startup-folder .lnk approach. The Scheduled Task adds
    three properties the .lnk could not provide:

    1. Restart-on-failure: if the launcher exits non-zero (or the python
       child crashes), Windows retries up to 3 times at 1-minute intervals.
       This absorbs the known Foundry EP cold-boot flakiness without any
       code in the launcher itself. (1 minute is the documented minimum
       for RestartInterval; values smaller than PT1M are rejected by
       Register-ScheduledTask.)
    2. Single-instance: MultipleInstances=IgnoreNew prevents duplicate
       servers when the user logs in/out repeatedly.
    3. Hidden: no console window flashes during boot.

    Returns a dict {ok: bool, error: str|None} so the caller can surface
    failures to the UI instead of silently claiming runOnStartup=true.

    Migration: any pre-existing TaskBean.lnk in the Startup folder is
    removed regardless of the new enabled state, so users with the old
    layout get cleaned up automatically.
    """
    log = logging.getLogger(__name__)
    launch_ps1 = Path(__file__).parent.parent / "launch.ps1"
    working_dir = launch_ps1.parent
    task_name = "TaskBean"

    # Always migrate away from the legacy shortcut, regardless of the new
    # enabled value — we never want both mechanisms running at once.
    legacy = _legacy_shortcut_path()
    try:
        if legacy.is_file():
            legacy.unlink()
            log.info("Migrated away from legacy startup shortcut at %s", legacy)
    except Exception as exc:
        log.warning("Could not remove legacy startup shortcut: %s", exc)

    if not enabled:
        # Unregister-ScheduledTask is idempotent when -ErrorAction SilentlyContinue is set.
        script = (
            f'Unregister-ScheduledTask -TaskName "{task_name}" -Confirm:$false '
            f'-ErrorAction SilentlyContinue | Out-Null'
        )
        try:
            res = _run_powershell(script)
            if res.returncode != 0:
                return {"ok": False, "error": (res.stderr or "").strip() or "Unregister-ScheduledTask failed"}
            log.info("Removed scheduled task '%s'", task_name)
            return {"ok": True, "error": None}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    # Build a Register-ScheduledTask invocation. The launcher is invoked in
    # background mode so it never prompts and surfaces errors via the
    # /api/launch-errors file the PWA reads on reconnect.
    script = (
        f'$action = New-ScheduledTaskAction `\n'
        f'    -Execute "powershell.exe" `\n'
        f'    -Argument \'-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "{launch_ps1}" -Mode background\' `\n'
        f'    -WorkingDirectory "{working_dir}";\n'
        f'$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;\n'
        f'$settings = New-ScheduledTaskSettingsSet `\n'
        f'    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `\n'
        f'    -ExecutionTimeLimit ([TimeSpan]::Zero) `\n'
        f'    -MultipleInstances IgnoreNew `\n'
        f'    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `\n'
        f'    -Hidden;\n'
        f'$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited;\n'
        f'Register-ScheduledTask -TaskName "{task_name}" -Action $action -Trigger $trigger '
        f'-Settings $settings -Principal $principal -Force | Out-Null'
    )
    try:
        res = _run_powershell(script, timeout=20)
        if res.returncode != 0:
            err = (res.stderr or "").strip() or "Register-ScheduledTask failed"
            log.warning("Scheduled task registration failed: %s", err)
            return {"ok": False, "error": err}
        log.info("Registered scheduled task '%s' for %s", task_name, launch_ps1)
        return {"ok": True, "error": None}
    except Exception as exc:
        log.warning("Scheduled task sync raised: %s", exc)
        return {"ok": False, "error": str(exc)}


# Back-compat alias so any external caller (or stray import) still works.
_sync_startup_shortcut = _sync_startup_scheduled_task


@app.get("/api/port-info")
async def port_info() -> dict:
    return {
        "port": int(app_config.get("port") or 8275),
        "default": 8275,
        "conflict": None,
        "configurable": True,
    }


class PortBody(BaseModel):
    port: int


@app.post("/api/port")
async def set_port(body: PortBody) -> dict:
    if body.port < 1024 or body.port > 65535:
        raise HTTPException(400, "Port must be between 1024 and 65535")
    app_config.set("port", body.port)
    return {"ok": True, "port": body.port, "message": f"Port set to {body.port}. Restart taskbean for it to take effect."}


@app.get("/api/port-info")
async def port_info() -> dict:
    return {
        "port": int(app_config.get("port") or 8275),
        "default": 8275,
        "conflict": None,
        "configurable": True,
    }


class PortBody(BaseModel):
    port: int


@app.post("/api/port")
async def set_port(body: PortBody) -> dict:
    if body.port < 1024 or body.port > 65535:
        raise HTTPException(400, "Port must be between 1024 and 65535")
    app_config.set("port", body.port)
    return {"ok": True, "port": body.port, "message": f"Port set to {body.port}. Restart taskbean for it to take effect."}


@app.post("/api/config")
async def update_config(patch: ConfigPatch) -> dict:
    """Persist one or more config fields. Unknown fields are ignored.
    
    Validates ALL fields BEFORE persisting ANY of them. If validation fails,
    NO changes are persisted.
    """
    # Phase 1: Validate everything, collect pending changes
    pending: dict[str, Any] = {}
    errors = []

    # Validate simple enum/string fields
    mapping = {
        "modelPermission": ("modelPermission", {"ask", "yolo"}),
        "preferredDevice": ("preferredDevice", {"auto", "npu", "gpu", "cpu"}),
        "preferredModel":  ("preferredModel", None),  # None means free-form string
    }
    for attr, (key, allowed) in mapping.items():
        val = getattr(patch, attr)
        if val is None:
            continue
        if allowed and val.lower() not in allowed:
            errors.append(f"{key} must be one of {sorted(allowed)}, got '{val}'")
            continue
        pending[key] = val.lower() if allowed else val

    # Validate runOnStartup
    if patch.runOnStartup is not None:
        pending["runOnStartup"] = patch.runOnStartup

    # Validate autoSelectIcon
    if patch.autoSelectIcon is not None:
        pending["autoSelectIcon"] = patch.autoSelectIcon

    # Validate timezone
    if patch.timezone is not None:
        if patch.timezone == "":
            pending["timezone"] = None  # clear = use OS default
        else:
            try:
                from zoneinfo import ZoneInfo
                ZoneInfo(patch.timezone)  # validate it's a real timezone
                pending["timezone"] = patch.timezone
            except (KeyError, Exception):
                errors.append(f"Invalid timezone: '{patch.timezone}'")

    # Validate hideIncompatibleModels
    if patch.hideIncompatibleModels is not None:
        pending["hideIncompatibleModels"] = patch.hideIncompatibleModels

    # Validate toolCallOnly
    if patch.toolCallOnly is not None:
        pending["toolCallOnly"] = patch.toolCallOnly

    # Validate schedule(deep merge into pending, don't persist yet)
    if patch.schedule is not None:
        current_schedule = dict(app_config.get("schedule") or app_config._DEFAULTS["schedule"])
        for block_name in ("dnd", "reminderHours"):
            block = getattr(patch.schedule, block_name, None)
            if block is not None:
                current_block = dict(current_schedule.get(block_name, {}))
                if block.start is not None:
                    current_block["start"] = block.start
                if block.end is not None:
                    current_block["end"] = block.end
                if block.days is not None:
                    valid_days = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
                    invalid_days = [d for d in block.days if d not in valid_days]
                    if invalid_days:
                        errors.append(f"schedule.{block_name}.days contains invalid values: {invalid_days}")
                    else:
                        current_block["days"] = block.days
                if block.enabled is not None:
                    current_block["enabled"] = block.enabled
                current_schedule[block_name] = current_block
        pending["schedule"] = current_schedule

    # Validate speech config (deep merge into pending, don't persist yet)
    if patch.speech is not None:
        current_speech = dict(app_config.get("speech") or app_config._DEFAULTS.get("speech", {}))
        valid_engines = {"auto", "web", "whisper", "live"}
        valid_fallbacks = {"web", "whisper", "none"}
        valid_actions = {"compose", "extract"}
        if patch.speech.engine is not None:
            if patch.speech.engine.lower() not in valid_engines:
                errors.append(f"speech.engine must be one of {sorted(valid_engines)}")
            else:
                current_speech["engine"] = patch.speech.engine.lower()
        if patch.speech.fallback is not None:
            if patch.speech.fallback.lower() not in valid_fallbacks:
                errors.append(f"speech.fallback must be one of {sorted(valid_fallbacks)}")
            else:
                current_speech["fallback"] = patch.speech.fallback.lower()
        if patch.speech.micDevice is not None:
            current_speech["micDevice"] = patch.speech.micDevice or None
        if patch.speech.action is not None:
            if patch.speech.action.lower() not in valid_actions:
                errors.append(f"speech.action must be one of {sorted(valid_actions)}")
            else:
                current_speech["action"] = patch.speech.action.lower()
        if patch.speech.whisperModel is not None:
            new_alias = (patch.speech.whisperModel or "").strip()
            if not new_alias:
                errors.append("speech.whisperModel must be a non-empty alias")
            else:
                # Validate the alias actually exists and is a voice model.
                catalog_entry = next(
                    (m for m in get_model_catalog() if m["alias"] == new_alias),
                    None,
                )
                if catalog_entry is None:
                    errors.append(f"speech.whisperModel '{new_alias}' not found in catalog")
                elif catalog_entry.get("modality") != "voice":
                    errors.append(f"speech.whisperModel '{new_alias}' is not a voice model")
                else:
                    prior_alias = (current_speech.get("whisperModel") or "").strip() or DEFAULT_WHISPER_ALIAS
                    current_speech["whisperModel"] = new_alias
                    # Variant change → drop the cached client so the next
                    # /api/transcribe lazy-loads the new variant. Side effect
                    # runs after persistence (below).
                    if new_alias != prior_alias:
                        pending["_whisperVariantChanged"] = True
        pending["speech"] = current_speech

    # Phase 2: If errors, reject entirely without persisting anything
    if errors:
        raise HTTPException(400, "; ".join(errors))

    # Phase 3: Persist all validated changes
    for key, value in pending.items():
        if key.startswith("_"):
            continue  # internal flags consumed in side-effect phase
        app_config.set(key, value)

    # Side effect: if the user changed their Whisper variant, drop the
    # cached _whisper_model so the next request lazy-loads the new one.
    if pending.pop("_whisperVariantChanged", False):
        try:
            await reset_whisper_client()
        except Exception as exc:
            logger.warning("Whisper client reset after variant change failed: %s", exc)

    # Handle side effects after successful persistence
    startup_warning = None
    if "runOnStartup" in pending:
        result = _sync_startup_scheduled_task(pending["runOnStartup"])
        if not result.get("ok"):
            # The persisted setting may now be misleading (UI says enabled,
            # task isn't actually registered). Flip it back so what the UI
            # shows matches reality, and surface the error in the response.
            app_config.set("runOnStartup", not pending["runOnStartup"])
            startup_warning = result.get("error") or "Failed to update startup task"

    response = {**app_config.all_settings(), "hardware": hw_mod.detect_hardware().to_dict()}
    if startup_warning:
        response["startupWarning"] = startup_warning
    return response


# ── Model switch (atomic, locked, permission-aware) ───────────────────────────

class SwitchRequest(BaseModel):
    modelId: str
    forceDownload: bool = False


@app.post("/api/models/switch")
async def switch_model(body: SwitchRequest) -> StreamingResponse:
    model_id = body.modelId
    force_download = body.forceDownload

    catalog = get_model_catalog()
    entry = next((m for m in catalog if m["modelId"] == model_id), None)
    if not entry:
        raise HTTPException(404, f'Model "{model_id}" not found in catalog')

    async def _stream():
        def send(type_: str, payload: dict = {}):
            return f"data: {json.dumps({'type': type_, **payload})}\n\n"

        async def _commit_switch(target_model: Any) -> str | None:
            """Atomically update all module-level state and rebuild the agent.

            Runs an inference smoke test against the new model BEFORE
            declaring success. If the smoke test fails, all module state is
            rolled back so /api/health doesn't lie about model_ready.

            Returns:
                Error message if the smoke test failed, or None on success.
            """
            # Snapshot prior state for rollback on smoke-test failure
            prev_model_id = agent_mod.MODEL_ID
            prev_model_alias = agent_mod.MODEL_ALIAS
            prev_model_context = dict(agent_mod.MODEL_CONTEXT)
            prev_model_ready = agent_mod.model_ready
            prev_startup_error = agent_mod.startup_error

            agent_mod.MODEL_ID = target_model.id
            agent_mod.MODEL_ALIAS = target_model.alias
            agent_mod._update_model_context(target_model)
            global _catalog_cache
            _catalog_cache = None
            # Ensure the web service is running (may not be if default model
            # failed at startup).
            await agent_mod._ensure_web_service()

            # ── Smoke test ─────────────────────────────────────────────
            # Verify the model can actually serve a non-streaming inference
            # request before declaring it ready. Catches Foundry-side
            # failures (model loaded but ONNX session broken, EP missing,
            # context-length issues, etc.) at switch time rather than at
            # chat time.
            smoke_error = await _smoke_test_inference(target_model.id)
            if smoke_error:
                # Roll back module state so /api/health reflects reality
                agent_mod.MODEL_ID = prev_model_id
                agent_mod.MODEL_ALIAS = prev_model_alias
                agent_mod.MODEL_CONTEXT.clear()
                agent_mod.MODEL_CONTEXT.update(prev_model_context)
                agent_mod.model_ready = prev_model_ready
                agent_mod.startup_error = prev_startup_error
                logger.warning(
                    "Smoke test failed for %s; rolled back to %s",
                    target_model.id, prev_model_id or "(none)",
                )
                return smoke_error

            agent_mod.model_ready = True
            agent_mod.startup_error = None
            agent_mod.build_agent()

            # Persist as full model ID, not alias. Alias persistence would
            # re-trigger device-variant selection on restart and could bounce
            # us back onto a broken NPU model. Locking in the exact variant
            # ensures the same model loads on next startup.
            try:
                app_config.set("preferredModel", target_model.id)
            except Exception as exc:  # config write should not fail the switch
                logger.warning("Failed to persist preferredModel: %s", exc)
            return None

        # ── Acquire switch lock ────────────────────────────────────────────────
        lock = app_config.get_switch_lock()
        if lock.locked():
            yield send("error", {"message": "A model switch is already in progress."})
            return

        async with lock:
          with telem.tracer.start_as_current_span("model.switch") as span:
            span.set_attribute("target_model", model_id)
            span.add_event("switch.started")
            # ── Resolve model via new SDK ──────────────────────────────────────
            target_model = None
            try:
                manager = get_fl_manager()
                # Try by full model ID first, then by alias
                target_model = await asyncio.to_thread(
                    lambda: manager.catalog.get_model_variant(model_id)
                           or manager.catalog.get_model(model_id)
                )
            except Exception as e:
                logger.warning("SDK model lookup failed: %s", e)

            if target_model is None:
                span.set_status(trace.StatusCode.ERROR, f'Model "{model_id}" not found in catalog')
                yield send("error", {"message": f'Model "{model_id}" not found in catalog'})
                return

            cached = await asyncio.to_thread(lambda: target_model.is_cached)

            if not cached and not force_download:
                # ── Ask mode: emit recommendation, do not download ─────────────
                permission = app_config.model_permission()
                if permission == "ask":
                    hw = hw_mod.detect_hardware()
                    pref_device = app_config.preferred_device()
                    loaded_catalog: list[dict] = []
                    try:
                        loaded_ids = {
                            m.id for m in await asyncio.to_thread(manager.catalog.get_loaded_models)
                        }
                        loaded_catalog = [{**m, "loaded": m["modelId"] in loaded_ids} for m in catalog]
                    except Exception:
                        pass
                    alt = recommender.best_for_task(
                        loaded_catalog, "tool_calling", hw, pref_device,
                        exclude_model_id=model_id, require_loaded=True,
                    )
                    event: dict = {
                        "requestedModel": {
                            "modelId": model_id,
                            "alias": entry.get("alias"),
                            "fileSizeGb": entry.get("fileSizeGb"),
                            "device": entry.get("device"),
                        },
                        "reason": (
                            f'"{entry.get("alias")}" is not downloaded locally '
                            f'({entry.get("fileSizeGb")} GB). '
                            "Set forceDownload: true to download and load it."
                        ),
                        "permission": "ask",
                        "action": "Retry with forceDownload: true to proceed.",
                    }
                    if alt:
                        event["recommendedAlternative"] = {
                            "modelId": alt["modelId"],
                            "alias": alt.get("alias"),
                            "device": alt.get("device"),
                            "maxOutputTokens": alt.get("maxOutputTokens"),
                            "score": alt.get("_score"),
                            "reason": "Already loaded — optimal for current hardware and task.",
                        }
                    yield send("recommendation", event)
                    return

            # ── Unload all loaded models via native FFI (prevents NPU poisoning) ─
            yield send("progress", {"message": "Preparing NPU — unloading active models…"})
            try:
                for loaded in await asyncio.to_thread(manager.catalog.get_loaded_models):
                    if loaded.id != model_id:
                        logger.info("Unloading %s before switch", loaded.id)
                        await asyncio.to_thread(loaded.unload)
            except Exception as e:
                logger.warning("Pre-switch unload failed (non-fatal): %s", e)

            # ── Download if not cached (with real-time progress) ───────────────
            if not cached:
                file_size_gb = entry.get('fileSizeGb')
                yield send("progress", {
                    "message": f"Downloading {entry['alias']}…",
                    "pct": 0,
                    "fileSizeGb": file_size_gb,
                })
                try:
                    loop = asyncio.get_event_loop()
                    progress_queue: asyncio.Queue = asyncio.Queue()

                    def _on_progress(pct: float):
                        loop.call_soon_threadsafe(progress_queue.put_nowait, pct)

                    download_task = asyncio.create_task(
                        asyncio.to_thread(lambda: target_model.download(_on_progress))
                    )
                    last_pct = -1.0
                    while not download_task.done():
                        try:
                            pct = await asyncio.wait_for(progress_queue.get(), timeout=0.5)
                            if pct - last_pct >= 1:  # throttle to every 1%
                                yield send("progress", {
                                    "message": f"Downloading {entry['alias']}…",
                                    "pct": round(pct, 1),
                                    "fileSizeGb": file_size_gb,
                                })
                                last_pct = pct
                        except asyncio.TimeoutError:
                            pass
                    await download_task  # re-raise if download failed
                except Exception as exc:
                    span.set_status(trace.StatusCode.ERROR, f"Download failed: {exc}")
                    span.record_exception(exc)
                    yield send("error", {"message": f"Download failed: {exc}"})
                    return
                yield send("progress", {"message": "Download complete.", "pct": 100, "fileSizeGb": file_size_gb})

            # ── Load via native SDK FFI ────────────────────────────────────────
            yield send("progress", {"message": f"Loading {entry['alias']}…"})
            try:
                await asyncio.to_thread(target_model.load)
            except Exception as exc:
                span.set_status(trace.StatusCode.ERROR, f"Load failed: {exc}")
                span.record_exception(exc)
                # Clear preference if it was pointing at this broken model so
                # the user isn't stuck loading the same failing model on next
                # restart.
                _clear_preferred_if_matches(model_id)
                yield send("error", {"message": f"Load failed: {exc}"})
                return

            commit_error = await _commit_switch(target_model)
            if commit_error:
                span.set_status(trace.StatusCode.ERROR, commit_error)
                # Note: we do NOT call _clear_preferred_if_matches here.
                # Smoke test failures can be transient — Foundry NPU runtimes
                # crash intermittently on agent payloads (Foundry-Local#506),
                # but a fresh process restart often recovers. Clearing the
                # preference here would silently revert a user's explicit
                # model choice on a transient hiccup. The user can clear it
                # manually via Settings if they want a different default.
                # Load failures (above) are different — those mean the model
                # fundamentally cannot load, so clearing preference is correct.
                yield send("error", {"message": commit_error})
                return
            span.add_event("switch.done", {"alias": entry["alias"]})
            yield send("done", {"modelId": model_id, "alias": entry["alias"]})

    return StreamingResponse(_stream(), media_type="text/event-stream")


def _clear_preferred_if_matches(model_id: str) -> None:
    """Clear preferredModel if it currently equals ``model_id``.

    Called after a failed switch so the user isn't stuck attempting to
    load the same broken model on every restart.
    """
    try:
        if app_config.preferred_model() == model_id:
            app_config.set("preferredModel", None)
            logger.info("Cleared stale preferredModel=%s", model_id)
    except Exception as exc:
        logger.warning("Failed to clear preferredModel: %s", exc)


# ── Todo CRUD ─────────────────────────────────────────────────────────────────


@app.get("/api/todos")
async def get_todos() -> list:
    """Return in-memory todos merged with CLI-written SQLite todos.

    CLI `bean add` / `bean done` writes to `~/.taskbean/taskbean.db` directly;
    without this merge those rows stay invisible until the user reloads. DB
    is source of truth for rows whose `id` exists in both halves (so a `bean
    done` after the server booted reflects immediately).
    """
    mem = list(state_mod.todos)
    mem_by_id = {t.get("id"): i for i, t in enumerate(mem) if t.get("id")}

    conn = _get_taskbean_db()
    if not conn:
        return mem
    try:
        rows = conn.execute(
            "SELECT id, title, emoji, due_date as dueDate, due_time as dueTime, "
            "completed, reminder, remind_at as remindAt, reminder_fired as reminderFired, "
            "source, priority, notes, tags, project, created_at as createdAt "
            "FROM todos ORDER BY created_at DESC"
        ).fetchall()
    finally:
        conn.close()

    for r in rows:
        d = dict(r)
        d["completed"] = bool(d["completed"])
        d["reminder"] = bool(d.get("reminder"))
        d["reminderFired"] = bool(d.get("reminderFired"))
        # tags is stored in SQLite as a JSON string; the frontend expects a list.
        raw_tags = d.get("tags")
        if isinstance(raw_tags, str):
            try:
                d["tags"] = json.loads(raw_tags) if raw_tags else []
            except (ValueError, TypeError):
                d["tags"] = []
        elif raw_tags is None:
            d["tags"] = []
        idx = mem_by_id.get(d["id"])
        if idx is None:
            mem.append(d)
        else:
            # DB is source of truth for completion state of shared rows.
            mem[idx] = {**mem[idx], **d}
    return mem


class TodoCreate(BaseModel):
    title: str
    emoji: str | None = None
    dueDate: str | None = None
    dueTime: str | None = None
    priority: str | None = None
    notes: str | None = None
    tags: list[str] | None = None
    status: str | None = None


@app.get("/api/todos/overdue")
async def todos_overdue() -> list:
    now = datetime.now(timezone.utc)
    overdue = []
    for t in state_mod.todos:
        if not t.get("reminder") or t.get("completed") or t.get("reminderFired"):
            continue
        remind_at = t.get("remindAt")
        if not remind_at:
            continue
        try:
            remind_dt = datetime.fromisoformat(remind_at)
            if remind_dt > now:
                continue
            delta = now - remind_dt
            mins = int(delta.total_seconds() / 60)
            if mins < 60:
                overdue_since = f"{mins}m ago"
            elif mins < 1440:
                overdue_since = f"{mins // 60}h ago"
            else:
                overdue_since = f"{mins // 1440}d ago"
            overdue.append({**t, "overdueSince": overdue_since})
        except (ValueError, TypeError):
            continue
    return overdue


@app.post("/api/todos", status_code=201)
async def create_todo(body: TodoCreate) -> dict:
    todo = state_mod.add_todo(
        title=body.title,
        emoji=body.emoji,
        due_date=body.dueDate,
        due_time=body.dueTime,
        priority=body.priority,
        notes=body.notes,
        tags=body.tags,
    )
    return todo


class TodoPatch(BaseModel):
    completed: bool | None = None
    title: str | None = None
    dueDate: str | None = None
    dueTime: str | None = None
    priority: str | None = None
    notes: str | None = None
    tags: list[str] | None = None
    reminder: bool | None = None
    remindAt: str | None = None
    reminderFired: bool | None = None
    status: str | None = None


@app.patch("/api/todos/{todo_id}")
async def patch_todo(todo_id: str, patch: TodoPatch) -> dict:
    fields = {k: v for k, v in patch.model_dump(exclude_unset=True).items() if v is not None}
    # Auto-sync status when completed changes (frontend compat)
    if "completed" in fields and "status" not in fields:
        fields["status"] = "done" if fields["completed"] else "pending"
    todo = state_mod.update_todo(todo_id, **fields)
    if not todo:
        raise HTTPException(404, "Not found")
    return todo


@app.delete("/api/todos/{todo_id}")
async def delete_todo(todo_id: str) -> dict:
    idx = next((i for i, t in enumerate(state_mod.todos) if t["id"] == todo_id), None)
    if idx is None:
        raise HTTPException(404, "Not found")
    state_mod.todos.pop(idx)
    try:
        import persistence
        persistence.delete_todo(todo_id)
    except Exception as e:
        logger.warning("Failed to delete todo from DB: %s", e)
    return {"success": True}


@app.get("/api/todos/{todo_id}")
async def todo_action(todo_id: str, action: str | None = None):
    """Handle toast notification actions (Done/Snooze) via GET URL."""
    todo = next((t for t in state_mod.todos if t["id"] == todo_id), None)
    if not todo:
        return HTMLResponse("<h2>❌ Task not found</h2><p>It may have been deleted.</p>", status_code=404)

    if action == "complete":
        todo["completed"] = True
        todo["status"] = "done"
        try:
            import persistence
            persistence.update_todo_fields(todo)
        except Exception:
            pass
        return HTMLResponse(
            "<h2>✅ Done!</h2>"
            f"<p>Marked <strong>{todo['title']}</strong> as complete.</p>"
            "<p style='color:gray;font-size:12px'>You can close this tab.</p>"
        )
    elif action == "snooze":
        from datetime import datetime as dt, timedelta, timezone as tz
        snooze_until = (dt.now(tz.utc) + timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
        todo["reminder"] = True
        todo["remindAt"] = snooze_until
        todo["reminderFired"] = False
        try:
            import persistence
            persistence.update_todo_fields(todo)
        except Exception:
            pass
        return HTMLResponse(
            "<h2>⏰ Snoozed</h2>"
            f"<p><strong>{todo['title']}</strong> will remind you again in 10 minutes.</p>"
            "<p style='color:gray;font-size:12px'>You can close this tab.</p>"
        )
    else:
        return JSONResponse(todo)


# ── Projects (reads from CLI's SQLite DB) ─────────────────────────────────────


def _ensure_projects_schema(conn):
    """Ensure projects table has hidden + category columns (migration)."""
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info('projects')").fetchall()}
        if 'hidden' not in cols:
            conn.execute("ALTER TABLE projects ADD COLUMN hidden INTEGER DEFAULT 0")
        if 'category' not in cols:
            conn.execute("ALTER TABLE projects ADD COLUMN category TEXT DEFAULT NULL")
        conn.commit()
    except Exception:
        pass  # safe no-op if table doesn't exist yet


def _get_taskbean_db():
    """Open the shared taskbean SQLite DB (read-only)."""
    import sqlite3
    db_path = os.path.join(os.path.expanduser("~"), ".taskbean", "taskbean.db")
    if not os.path.exists(db_path):
        return None
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn
    return conn


def _get_taskbean_db_rw():
    """Open the shared taskbean SQLite DB (read-write)."""
    import sqlite3
    db_path = os.path.join(os.path.expanduser("~"), ".taskbean", "taskbean.db")
    if not os.path.exists(db_path):
        return None
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    _ensure_projects_schema(conn)
    return conn


@app.get("/api/projects")
async def get_projects(show_hidden: bool = False, category: str | None = None) -> list:
    """Return tracked projects from CLI's SQLite DB, merged with in-memory todo counts."""
    conn = _get_taskbean_db()
    if not conn:
        return []
    try:
        # Detect whether migration has run (columns may not exist on old DBs)
        cols = {row[1] for row in conn.execute("PRAGMA table_info('projects')").fetchall()}
        has_hidden = 'hidden' in cols
        has_category = 'category' in cols

        where = "WHERE tracked = 1"
        params_list: list[str] = []
        if not show_hidden and has_hidden:
            where += " AND hidden = 0"
        if category and has_category:
            where += " AND category = ?"
            params_list.append(category)

        select_cols = "name, path, skill_installed"
        if has_hidden:
            select_cols += ", hidden"
        if has_category:
            select_cols += ", category"

        rows = conn.execute(
            f"SELECT {select_cols} FROM projects {where} ORDER BY name",
            params_list,
        ).fetchall()
        # Batch-fetch todo counts for all tracked projects in one query
        names = [r["name"] for r in rows]
        todo_counts: dict[str, dict] = {}
        if names:
            placeholders = ",".join("?" * len(names))
            for row in conn.execute(
                f"SELECT project, COUNT(*) as total, "
                f"SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as done "
                f"FROM todos WHERE project IN ({placeholders}) GROUP BY project",
                names,
            ).fetchall():
                todo_counts[row["project"]] = {"total": row["total"] or 0, "done": row["done"] or 0}
    finally:
        conn.close()

    result = []
    for r in rows:
        name = r["name"]
        sc = todo_counts.get(name, {"total": 0, "done": 0})
        result.append({
            "name": name,
            "path": r["path"],
            "hidden": bool(r["hidden"]) if has_hidden else False,
            "category": r["category"] if has_category else None,
            "skill_installed": bool(r["skill_installed"]),
            "total": sc["total"],
            "done": sc["done"],
            "pending": sc["total"] - sc["done"],
        })
    return result


@app.get("/api/projects/tasks")
async def get_project_tasks(project: str = "") -> list:
    """Return todos for a specific project (from both in-memory state and SQLite)."""
    if not project:
        return []
    # In-memory todos
    mem_todos = [t for t in state_mod.todos if t.get("project") == project]
    # SQLite todos
    conn = _get_taskbean_db()
    db_todos = []
    if conn:
        try:
            rows = conn.execute(
                "SELECT id, title, emoji, due_date as dueDate, due_time as dueTime, "
                "completed, source, priority, notes, tags, project, created_at as createdAt, "
                "agent, agent_session_id as agentSessionId "
                "FROM todos WHERE project = ? ORDER BY created_at DESC",
                (project,),
            ).fetchall()
            db_todos = [dict(r) for r in rows]
            # Normalize completed to bool
            for t in db_todos:
                t["completed"] = bool(t["completed"])
        finally:
            conn.close()
    # Deduplicate by id (in-memory wins)
    mem_ids = {t["id"] for t in mem_todos}
    combined = mem_todos + [t for t in db_todos if t["id"] not in mem_ids]
    return combined


# ── Project management ────────────────────────────────────────────────────────

class ProjectActionBody(BaseModel):
    """Body for project hide/show/category actions."""
    pass

class ProjectCategoryBody(BaseModel):
    category: str | None = None

def _find_project(conn, name_or_path: str):
    """Find a project by path (unique) or name (must be unambiguous)."""
    row = conn.execute("SELECT * FROM projects WHERE path = ?", (name_or_path,)).fetchone()
    if row:
        return row
    rows = conn.execute("SELECT * FROM projects WHERE name = ?", (name_or_path,)).fetchall()
    if len(rows) == 1:
        return rows[0]
    if len(rows) > 1:
        raise HTTPException(status_code=409, detail=f"Ambiguous: {len(rows)} projects named '{name_or_path}'. Use full path.")
    return None

@app.post("/api/projects/{name}/hide")
async def hide_project(name: str) -> dict:
    """Hide a project from default views."""
    conn = _get_taskbean_db_rw()
    if not conn:
        raise HTTPException(status_code=500, detail="database unavailable")
    try:
        row = _find_project(conn, name)
        if not row:
            raise HTTPException(status_code=404, detail=f"Project not found: {name}")
        conn.execute("UPDATE projects SET hidden = 1 WHERE id = ?", (row["id"],))
        conn.commit()
        return {"status": "hidden", "project": row["name"]}
    finally:
        conn.close()

@app.post("/api/projects/{name}/show")
async def show_project(name: str) -> dict:
    """Un-hide a project."""
    conn = _get_taskbean_db_rw()
    if not conn:
        raise HTTPException(status_code=500, detail="database unavailable")
    try:
        row = _find_project(conn, name)
        if not row:
            raise HTTPException(status_code=404, detail=f"Project not found: {name}")
        conn.execute("UPDATE projects SET hidden = 0 WHERE id = ?", (row["id"],))
        conn.commit()
        return {"status": "visible", "project": row["name"]}
    finally:
        conn.close()

@app.post("/api/projects/{name}/category")
async def set_project_category(name: str, body: ProjectCategoryBody) -> dict:
    """Set or clear a project's category."""
    conn = _get_taskbean_db_rw()
    if not conn:
        raise HTTPException(status_code=500, detail="database unavailable")
    try:
        row = _find_project(conn, name)
        if not row:
            raise HTTPException(status_code=404, detail=f"Project not found: {name}")
        conn.execute("UPDATE projects SET category = ? WHERE id = ?", (body.category, row["id"]))
        conn.commit()
        return {"status": "updated", "project": row["name"], "category": body.category}
    finally:
        conn.close()

@app.post("/api/projects/{name}/delete")
async def delete_project(name: str) -> dict:
    """Delete a project by shelling out to bean projects delete."""
    _reject_shell_metachars(name, "name")
    conn = _get_taskbean_db_rw()
    if not conn:
        raise HTTPException(status_code=500, detail="database unavailable")
    try:
        row = _find_project(conn, name)
        if not row:
            raise HTTPException(status_code=404, detail=f"Project not found: {name}")
        project_path = row["path"]
    finally:
        conn.close()
    _reject_shell_metachars(project_path, "path")
    bean_cmd = "bean.cmd" if sys.platform == "win32" else "bean"
    args = [bean_cmd, "projects", "delete", project_path, "--confirm", "--json"]

    def _run():
        return subprocess.run(args, capture_output=True, text=True, timeout=60)

    try:
        result = await asyncio.to_thread(_run)
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail=f"'{bean_cmd}' not found on PATH")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="bean projects delete timed out")

    if result.returncode != 0:
        msg = (result.stderr or result.stdout or "delete failed").strip().splitlines()
        raise HTTPException(status_code=500, detail=msg[-1] if msg else "delete failed")

    stdout_lines = [ln for ln in result.stdout.splitlines() if ln.strip()]
    if not stdout_lines:
        return {"status": "deleted", "project": name}
    try:
        return json.loads(stdout_lines[-1])
    except json.JSONDecodeError:
        return {"status": "deleted", "project": name}

@app.post("/api/projects/{name}/untrack")
async def untrack_project(name: str) -> dict:
    """Untrack a project by shelling out to bean untrack."""
    conn = _get_taskbean_db()
    if not conn:
        raise HTTPException(status_code=500, detail="database unavailable")
    try:
        row = _find_project(conn, name)
        if not row:
            raise HTTPException(status_code=404, detail=f"Project not found: {name}")
        project_path = row["path"]
    finally:
        conn.close()

    _reject_shell_metachars(project_path, "path")
    bean_cmd = "bean.cmd" if sys.platform == "win32" else "bean"
    args = [bean_cmd, "untrack", "--path", project_path, "--json"]

    def _run():
        return subprocess.run(args, capture_output=True, text=True, timeout=60)

    try:
        result = await asyncio.to_thread(_run)
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail=f"'{bean_cmd}' not found on PATH")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="bean untrack timed out")

    if result.returncode != 0:
        msg = (result.stderr or result.stdout or "untrack failed").strip().splitlines()
        raise HTTPException(status_code=500, detail=msg[-1] if msg else "untrack failed")

    stdout_lines = [ln for ln in result.stdout.splitlines() if ln.strip()]
    if stdout_lines:
        try:
            return json.loads(stdout_lines[-1])
        except json.JSONDecodeError:
            pass
    return {"status": "untracked", "project": name}


# ── Filesystem browser (project picker) ──────────────────────────────────────
# Three endpoints power the click-based "Add project" picker:
#   GET  /api/fs/roots    quick-starts rail (home, drives, recent paths, …)
#   GET  /api/fs/browse   list one directory's subfolders with project signals
#   POST /api/projects/track   shells to `bean track` to register the folder
#
# These are localhost-only (see CORSMiddleware above). We still apply defensive
# path hygiene: reject ".." segments and never follow symlinks when deciding
# whether a child is a directory.

_FS_BROWSE_TIMEOUT_S = 5.0


def _safe_resolve_fs_path(raw: str) -> Path:
    """Normalize a user-supplied path; reject relative-traversal segments."""
    if not raw or not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="path is required")
    p = Path(raw).expanduser()
    if any(part == ".." for part in p.parts):
        raise HTTPException(status_code=400, detail="path may not contain '..' segments")
    if not p.is_absolute():
        raise HTTPException(status_code=400, detail="path must be absolute")
    return p.absolute()


# Characters that are dangerous to pass to cmd.exe (Windows invokes .cmd/.bat
# shims via cmd.exe regardless of shell=False). We reject these in any string
# that will reach `bean track` as an argument — folder/project names with
# these characters are extremely rare and can be renamed before tracking.
_SHELL_METACHARS_RE = re.compile(r'[&|<>^"%\r\n\x00]')


def _reject_shell_metachars(value: str, label: str) -> None:
    if _SHELL_METACHARS_RE.search(value or ""):
        raise HTTPException(
            status_code=400,
            detail=f"{label} contains disallowed characters (& | < > ^ \" % or newline)",
        )


def _scan_directory(p: Path, show_hidden: bool) -> list[dict]:
    """Synchronous scandir wrapped by fs_browse under asyncio.to_thread + timeout.

    Includes the preceding exists/is_dir checks inside the same thread so that
    dead network shares / disconnected mapped drives are timed out cleanly by
    the caller's `asyncio.wait_for(...)` wrapper.
    """
    if not p.exists():
        raise FileNotFoundError(str(p))
    if not p.is_dir():
        raise NotADirectoryError(str(p))
    entries: list[dict] = []
    with os.scandir(p) as it:
        for e in it:
            if not show_hidden and e.name.startswith(".") and e.name != ".git":
                continue
            try:
                if not e.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            child = Path(e.path)
            entries.append({
                "name": e.name,
                "path": str(child),
                "isDir": True,
                "isGitRepo": (child / ".git").exists(),
                "hasTaskbeanJson": (child / ".taskbean.json").exists(),
                "hasPackageJson": (child / "package.json").exists(),
                "hasPyProject": (child / "pyproject.toml").exists(),
            })
    entries.sort(key=lambda e: e["name"].lower())
    return entries


@app.get("/api/fs/roots")
async def fs_roots() -> dict:
    """Quick-start locations for the project picker rail."""
    home = Path.home()
    result: dict[str, Any] = {"home": str(home), "drives": [], "suggested": [], "recents": []}

    # Windows: enumerate logical drives via kernel32.GetLogicalDrives().
    if sys.platform == "win32":
        try:
            import ctypes
            import string
            bitmask = ctypes.windll.kernel32.GetLogicalDrives()  # type: ignore[attr-defined]
            result["drives"] = [
                f"{letter}:\\"
                for i, letter in enumerate(string.ascii_uppercase)
                if bitmask & (1 << i)
            ]
        except Exception:
            result["drives"] = ["C:\\"]
        # Add \\wsl$ if present so users can track WSL projects from Windows.
        wsl = Path(r"\\wsl$")
        if wsl.exists():
            result["drives"].append(r"\\wsl$")

    for name in ("personal", "code", "repos", "src", "projects", "work", "Documents"):
        candidate = home / name
        try:
            if candidate.is_dir():
                result["suggested"].append(str(candidate))
        except OSError:
            continue

    # Recents: most recently tracked project paths from SQLite.
    conn = _get_taskbean_db()
    if conn:
        try:
            rows = conn.execute(
                "SELECT name, path FROM projects WHERE tracked = 1 "
                "ORDER BY created_at DESC LIMIT 5"
            ).fetchall()
            result["recents"] = [{"name": r["name"], "path": r["path"]} for r in rows]
        finally:
            conn.close()

    return result


@app.get("/api/fs/browse")
async def fs_browse(path: str, show_hidden: bool = False) -> dict:
    """List subdirectories of `path`. Files are omitted — projects are always folders.

    exists/is_dir stat calls happen inside the worker thread so that dead
    UNC shares or disconnected mapped drives are cut off by the timeout.
    """
    p = _safe_resolve_fs_path(path)
    try:
        entries = await asyncio.wait_for(
            asyncio.to_thread(_scan_directory, p, show_hidden),
            timeout=_FS_BROWSE_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="listing this folder took too long (network share?)")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"not found: {p}")
    except NotADirectoryError:
        raise HTTPException(status_code=400, detail=f"not a directory: {p}")
    except PermissionError:
        raise HTTPException(status_code=403, detail="permission denied")

    parent_str: str | None = None
    try:
        parent = p.parent
        if parent != p:
            parent_str = str(parent)
    except Exception:
        parent_str = None

    return {"path": str(p), "parent": parent_str, "entries": entries}


class TrackProjectBody(BaseModel):
    path: str
    name: str | None = None


@app.post("/api/projects/track")
async def track_project(body: TrackProjectBody) -> dict:
    """Register a folder as a taskbean project by shelling out to `bean track`.

    We shell out (instead of duplicating the track logic in Python) so the CLI
    remains the single source of truth for the five side effects:
      1. write `.taskbean.json`
      2. upsert `projects` row
      3. mark `tracked=1`
      4. install agent skill
      5. set `skill_installed=1`
    """
    p = _safe_resolve_fs_path(body.path)
    _reject_shell_metachars(str(p), "path")
    if body.name:
        _reject_shell_metachars(body.name, "name")
    # Validate target is a directory (timeboxed so dead shares don't hang).
    def _is_dir() -> bool:
        return p.is_dir()
    try:
        is_dir = await asyncio.wait_for(asyncio.to_thread(_is_dir), timeout=_FS_BROWSE_TIMEOUT_S)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="checking folder took too long")
    except PermissionError:
        raise HTTPException(status_code=403, detail="permission denied")
    if not is_dir:
        raise HTTPException(status_code=400, detail="path is not a directory")

    bean_cmd = "bean.cmd" if sys.platform == "win32" else "bean"
    args: list[str] = [bean_cmd, "track", "--path", str(p), "--json"]
    if body.name:
        args.extend(["--name", body.name])

    def _run() -> subprocess.CompletedProcess:
        return subprocess.run(args, capture_output=True, text=True, timeout=60)

    try:
        result = await asyncio.to_thread(_run)
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail=f"'{bean_cmd}' not found on PATH — is taskbean installed globally?")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="bean track timed out")

    if result.returncode != 0:
        msg = (result.stderr or result.stdout or "bean track failed").strip().splitlines()
        raise HTTPException(status_code=500, detail=msg[-1] if msg else "bean track failed")

    # Parse the last non-empty stdout line as JSON (track emits one object on --json).
    stdout_lines = [ln for ln in result.stdout.splitlines() if ln.strip()]
    if not stdout_lines:
        raise HTTPException(status_code=500, detail="bean track returned no output")
    try:
        parsed = json.loads(stdout_lines[-1])
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="bean track returned non-JSON output")
    if not isinstance(parsed, dict) or "path" not in parsed:
        raise HTTPException(status_code=500, detail="bean track returned unexpected JSON shape")
    return parsed


# ── Multi-agent Usage Stats ──────────────────────────────────────────────────

from usage import ingest as usage_ingest  # noqa: E402
from usage.types import AGENTS as _USAGE_AGENTS  # noqa: E402


@app.get("/api/agent-usage")
async def get_agent_usage(period: str = "today", agents: str | None = None) -> dict:
    """Cross-agent usage (Copilot, Claude Code, Codex, OpenCode).

    Runs a rate-limited ingest pass then returns aggregate + per-agent stats.
    Pass ``agents=copilot,claude-code`` to filter.
    """
    wanted = None
    if agents:
        wanted = [a.strip() for a in agents.split(",") if a.strip() in _USAGE_AGENTS]
        if not wanted:
            wanted = None
    return await usage_ingest.get_agent_usage(period=period, agents=wanted)


@app.get("/api/agent-usage/detection")
async def get_agent_detection() -> dict:
    return await usage_ingest.get_detection_status()


class _AgentToggle(BaseModel):
    # StrictBool rejects truthy strings like "true"/"1" — the Settings UI
    # sends JSON bool, and we don't want a typo'd body to silently enable/disable.
    enabled: StrictBool


@app.post("/api/agent-usage/settings/{agent}")
async def set_agent_toggle(agent: str, body: _AgentToggle) -> dict:
    if agent not in _USAGE_AGENTS:
        raise HTTPException(status_code=400, detail=f"Unknown agent: {agent}")
    await usage_ingest.set_agent_enabled(agent, body.enabled)
    return {"agent": agent, "enabled": body.enabled}


# ── Copilot Usage Stats (back-compat shim) ───────────────────────────────────


@app.get("/api/copilot-usage")
async def get_copilot_usage(date: str = "today") -> dict:
    """Read Copilot CLI session stats from ~/.copilot/session-store.db."""
    import sqlite3

    copilot_db = os.path.join(os.path.expanduser("~"), ".copilot", "session-store.db")
    session_state = os.path.join(os.path.expanduser("~"), ".copilot", "session-state")
    if not os.path.exists(copilot_db):
        return {"available": False}

    try:
        conn = sqlite3.connect(f"file:{copilot_db}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row

        _DATE_CLAUSES = {
            "today": "date(created_at) = date('now', 'localtime')",
            "week": "date(created_at) >= date('now', '-7 days', 'localtime')",
            "all": "1=1",
        }
        date_clause = _DATE_CLAUSES.get(date, _DATE_CLAUSES["today"])

        sessions = conn.execute(
            f"SELECT id, cwd, summary, created_at FROM sessions WHERE {date_clause} ORDER BY created_at DESC"
        ).fetchall()
        conn.close()

        total_tokens = 0
        total_messages = 0
        total_turns = 0
        models: dict[str, int] = {}
        details = []

        for s in sessions:
            ev_path = os.path.join(session_state, s["id"], "events.jsonl")
            if not os.path.exists(ev_path):
                continue
            session_tokens = 0
            session_msgs = 0
            model = None
            try:
                with open(ev_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            ev = json.loads(line)
                            if ev.get("type") == "session.start":
                                model = (ev.get("data") or {}).get("selectedModel", "unknown")
                                models[model] = models.get(model, 0) + 1
                            if ev.get("type") == "assistant.message":
                                out_tok = (ev.get("data") or {}).get("outputTokens", 0)
                                if out_tok:
                                    session_tokens += out_tok
                                    session_msgs += 1
                            if ev.get("type") == "user.message":
                                total_turns += 1
                        except (json.JSONDecodeError, KeyError):
                            pass
            except OSError:
                pass
            total_tokens += session_tokens
            total_messages += session_msgs
            details.append({
                "id": s["id"],
                "summary": s["summary"],
                "model": model,
                "outputTokens": session_tokens,
                "messages": session_msgs,
                "createdAt": s["created_at"],
                "cwd": s["cwd"],
            })

        return {
            "available": True,
            "period": date,
            "sessions": len(sessions),
            "totalOutputTokens": total_tokens,
            "totalMessages": total_messages,
            "totalTurns": total_turns,
            "models": models,
            "details": details,
        }
    except Exception as e:
        return {"available": False, "error": str(e)}


# ── Task Detail (enriched with Copilot session data) ─────────────────────────


def _get_copilot_db():
    """Open the Copilot CLI session-store DB (read-only). Returns None if missing."""
    import sqlite3
    db_path = os.path.join(os.path.expanduser("~"), ".copilot", "session-store.db")
    if not os.path.exists(db_path):
        return None
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _parse_session_events(session_id: str) -> dict:
    """Parse events.jsonl for a session. Returns model, outputTokens, turns, tools, taskCompleteSummary."""
    state_dir = os.path.join(os.path.expanduser("~"), ".copilot", "session-state")
    ev_path = os.path.join(state_dir, session_id, "events.jsonl")
    result = {"model": None, "outputTokens": 0, "turns": 0, "tools": {}, "taskCompleteSummary": None}
    if not os.path.exists(ev_path):
        return result
    try:
        with open(ev_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                    ev_type = ev.get("type", "")
                    data = ev.get("data") or {}

                    if ev_type == "session.start":
                        result["model"] = data.get("selectedModel", "unknown")
                    elif ev_type == "user.message":
                        result["turns"] += 1
                    elif ev_type == "assistant.message":
                        result["outputTokens"] += data.get("outputTokens", 0)
                    elif ev_type == "tool.execution_complete":
                        tool_name = data.get("model") or "unknown"
                        # tool_name on execution_complete is the model; toolName is on execution_start
                    elif ev_type == "tool.execution_start":
                        tool_name = data.get("toolName", "unknown")
                        result["tools"][tool_name] = result["tools"].get(tool_name, 0) + 1
                    elif ev_type == "session.task_complete":
                        result["taskCompleteSummary"] = data.get("summary")
                    elif ev_type == "session.model_change":
                        result["model"] = data.get("newModel") or data.get("model") or result["model"]
                except (json.JSONDecodeError, KeyError):
                    pass
    except OSError:
        pass
    return result


def _correlate_session(task: dict, copilot_conn) -> dict | None:
    """Find the best Copilot session matching a task by project/time/title."""
    if copilot_conn is None:
        return None

    project = task.get("project") or ""
    title = task.get("title") or ""
    created_at = task.get("created_at") or ""

    candidates = []

    # Strategy 1: cwd contains project name AND created_at within ±30min
    if project and created_at:
        try:
            rows = copilot_conn.execute(
                "SELECT id, cwd, summary, repository, branch, created_at FROM sessions "
                "WHERE cwd LIKE ? AND abs(strftime('%s', created_at) - strftime('%s', ?)) < 1800 "
                "ORDER BY abs(strftime('%s', created_at) - strftime('%s', ?)) ASC LIMIT 5",
                (f"%{project}%", created_at, created_at),
            ).fetchall()
            candidates.extend(rows)
        except Exception:
            pass

    # Strategy 2: time-based only (±30min) if no project match yet
    if not candidates and created_at:
        try:
            rows = copilot_conn.execute(
                "SELECT id, cwd, summary, repository, branch, created_at FROM sessions "
                "WHERE abs(strftime('%s', created_at) - strftime('%s', ?)) < 1800 "
                "ORDER BY abs(strftime('%s', created_at) - strftime('%s', ?)) ASC LIMIT 5",
                (created_at, created_at),
            ).fetchall()
            candidates.extend(rows)
        except Exception:
            pass

    # Strategy 3: check task_complete summaries for title match
    if not candidates and title:
        state_dir = os.path.join(os.path.expanduser("~"), ".copilot", "session-state")
        try:
            recent = copilot_conn.execute(
                "SELECT id, cwd, summary, repository, branch, created_at FROM sessions "
                "ORDER BY created_at DESC LIMIT 50"
            ).fetchall()
            title_lower = title.lower()
            for s in recent:
                ev_path = os.path.join(state_dir, s["id"], "events.jsonl")
                if not os.path.exists(ev_path):
                    continue
                try:
                    with open(ev_path, "r", encoding="utf-8", errors="replace") as f:
                        for line in f:
                            if "session.task_complete" in line:
                                ev = json.loads(line.strip())
                                summary = (ev.get("data") or {}).get("summary", "")
                                if title_lower in summary.lower():
                                    candidates.append(s)
                                    break
                except (OSError, json.JSONDecodeError):
                    pass
                if candidates:
                    break
        except Exception:
            pass

    if not candidates:
        return None

    best = candidates[0]
    return dict(best)


async def _build_task_detail(task_id: str) -> dict:
    """Build enriched task detail combining in-memory state, taskbean DB, and Copilot session data."""
    # 1. Get task — check in-memory state first, then SQLite
    task = None
    mem_todo = next((t for t in state_mod.todos if t.get("id") == task_id), None)
    if mem_todo:
        task = dict(mem_todo)
    else:
        taskbean_conn = _get_taskbean_db()
        if taskbean_conn:
            try:
                row = taskbean_conn.execute("SELECT * FROM todos WHERE id = ?", (task_id,)).fetchone()
                if row:
                    task = dict(row)
            finally:
                taskbean_conn.close()
    if task is None:
        raise HTTPException(404, f"Task {task_id} not found")

    # 2. Correlate with Copilot session — only for Copilot-attributed or
    # unattributed tasks. For tasks owned by a non-Copilot agent, the
    # Source Card (below) carries the authoritative session info; the legacy
    # Copilot correlator would otherwise pick a nearby-in-time Copilot session
    # that has nothing to do with the task.
    copilot_conn = _get_copilot_db()
    try:
        task_agent = (task.get("agent") or "").lower()
        if task_agent in ("", "copilot"):
            session_row = _correlate_session(task, copilot_conn)
        else:
            session_row = None
    finally:
        if copilot_conn:
            copilot_conn.close()

    session_data = None
    files = []
    refs = []
    tools = {}
    checkpoint = None

    if session_row:
        sid = session_row["id"]

        # Parse events.jsonl in a thread (blocking I/O)
        ev_data = await asyncio.to_thread(_parse_session_events, sid)
        tools = ev_data["tools"]

        session_data = {
            "id": sid,
            "summary": session_row.get("summary"),
            "model": ev_data["model"],
            "branch": session_row.get("branch"),
            "repository": session_row.get("repository"),
            "outputTokens": ev_data["outputTokens"],
            "turns": ev_data["turns"],
            "taskCompleteSummary": ev_data["taskCompleteSummary"],
            "createdAt": session_row.get("created_at"),
        }

        # Get files, refs, checkpoint from Copilot DB
        copilot_conn2 = _get_copilot_db()
        if copilot_conn2:
            try:
                file_rows = copilot_conn2.execute(
                    "SELECT file_path, tool_name, turn_index FROM session_files WHERE session_id = ? ORDER BY turn_index",
                    (sid,),
                ).fetchall()
                files = [{"path": r["file_path"], "tool": r["tool_name"], "turn": r["turn_index"]} for r in file_rows]

                ref_rows = copilot_conn2.execute(
                    "SELECT ref_type, ref_value FROM session_refs WHERE session_id = ?",
                    (sid,),
                ).fetchall()
                refs = [{"type": r["ref_type"], "value": r["ref_value"]} for r in ref_rows]

                cp_row = copilot_conn2.execute(
                    "SELECT title, overview, work_done, technical_details FROM checkpoints "
                    "WHERE session_id = ? ORDER BY checkpoint_number DESC LIMIT 1",
                    (sid,),
                ).fetchone()
                if cp_row:
                    checkpoint = {
                        "title": cp_row["title"],
                        "overview": cp_row["overview"],
                        "workDone": cp_row["work_done"],
                        "technicalDetails": cp_row["technical_details"],
                    }
            finally:
                copilot_conn2.close()

    # Cross-agent source card (Copilot, Claude Code, Codex, OpenCode).
    # Enriches task-detail for any task with `todos.agent` + `agent_session_id`
    # stamped by the CLI attribution pipeline. Joins agent_sessions and
    # aggregates agent_turns to produce a single summary row.
    source_card = await asyncio.to_thread(_build_source_card, task)

    return {
        "task": {
            "id": task["id"],
            "title": task.get("title"),
            "completed": bool(task.get("completed")),
            "project": task.get("project"),
            "source": task.get("source"),
            "agent": task.get("agent"),
            "agent_session_id": task.get("agent_session_id"),
            "created_at": task.get("created_at"),
        },
        "session": session_data,
        "sourceCard": source_card,
        "files": files,
        "refs": refs,
        "tools": tools,
        "checkpoint": checkpoint,
    }


def _build_source_card(task: dict) -> dict | None:
    """Build a cross-agent Source Card payload for the task detail view.

    Returns None when the task has no agent attribution. Reads from the shared
    ``agent_sessions`` / ``agent_turns`` tables via the usage-module connector.
    """
    agent = task.get("agent")
    session_id = task.get("agent_session_id")
    if not agent or not session_id:
        return None
    try:
        from usage.db import connect as _usage_connect
    except Exception:
        return None
    conn = None
    try:
        conn = _usage_connect()
        sess = conn.execute(
            "SELECT id, agent, native_id, cwd, title, model, provider, "
            "cli_version, git_branch, started_at, updated_at "
            "FROM agent_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if not sess:
            return None
        agg = conn.execute(
            "SELECT COUNT(*) AS turns, "
            "COALESCE(SUM(input_tokens),0) AS input_tokens, "
            "COALESCE(SUM(cached_input_tokens),0) AS cached_input_tokens, "
            "COALESCE(SUM(output_tokens),0) AS output_tokens, "
            "COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens, "
            "COALESCE(SUM(total_tokens),0) AS total_tokens, "
            "COALESCE(SUM(tool_calls),0) AS tool_calls "
            "FROM agent_turns WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        last_model = conn.execute(
            "SELECT model FROM agent_turns WHERE session_id = ? "
            "AND model IS NOT NULL ORDER BY seq DESC LIMIT 1",
            (session_id,),
        ).fetchone()
    finally:
        if conn is not None:
            conn.close()

    effective_model = (last_model["model"] if last_model else None) or sess["model"]
    return {
        "agent": sess["agent"],
        "sessionId": sess["id"],
        "nativeId": sess["native_id"],
        "title": sess["title"],
        "model": effective_model,
        "sessionModel": sess["model"],
        "provider": sess["provider"],
        "cliVersion": sess["cli_version"],
        "gitBranch": sess["git_branch"],
        "cwd": sess["cwd"],
        "startedAt": sess["started_at"],
        "updatedAt": sess["updated_at"],
        "turns": agg["turns"] if agg else 0,
        "inputTokens": agg["input_tokens"] if agg else 0,
        "cachedInputTokens": agg["cached_input_tokens"] if agg else 0,
        "outputTokens": agg["output_tokens"] if agg else 0,
        "reasoningTokens": agg["reasoning_tokens"] if agg else 0,
        "totalTokens": agg["total_tokens"] if agg else 0,
        "toolCalls": agg["tool_calls"] if agg else 0,
    }


@app.get("/api/task-detail/{task_id}")
async def get_task_detail(task_id: str) -> dict:
    """Return enriched task detail with correlated Copilot session data."""
    return await _build_task_detail(task_id)


@app.get("/api/task-detail/{task_id}/export")
async def export_task_detail(task_id: str, format: str = "md") -> Any:
    """Export task detail as markdown or JSON."""
    detail = await _build_task_detail(task_id)

    if format == "json":
        return detail

    # Build markdown export
    task = detail["task"]
    session = detail["session"]
    status = "✅" if task["completed"] else "⏳"
    title = task.get("title") or "Untitled"

    lines = [f"## {status} {title}", ""]

    # Metadata line
    meta_parts = []
    if task.get("project"):
        meta_parts.append(f"**Project**: {task['project']}")
    if session and session.get("branch"):
        meta_parts.append(f"**Branch**: {session['branch']}")
    if task.get("created_at"):
        try:
            dt = datetime.fromisoformat(task["created_at"].replace("Z", "+00:00"))
            meta_parts.append(f"**Date**: {dt.strftime('%b %#d, %Y')}")
        except (ValueError, OSError):
            meta_parts.append(f"**Date**: {task['created_at'][:10]}")
    if meta_parts:
        lines.append(" · ".join(meta_parts))

    if session:
        ai_parts = []
        if session.get("model"):
            ai_parts.append(f"**AI Model**: {session['model']}")
        if session.get("turns"):
            ai_parts.append(f"**Turns**: {session['turns']}")
        if session.get("outputTokens"):
            ai_parts.append(f"**Tokens**: {session['outputTokens']:,}")
        if ai_parts:
            lines.append(" · ".join(ai_parts))

    lines.append("")

    # Summary
    summary = None
    if session and session.get("taskCompleteSummary"):
        summary = session["taskCompleteSummary"]
    elif detail.get("checkpoint") and detail["checkpoint"].get("overview"):
        summary = detail["checkpoint"]["overview"]

    if summary:
        lines.append("### Summary")
        lines.append(summary)
        lines.append("")

    # Files changed
    if detail["files"]:
        lines.append("### Files Changed")
        for f in detail["files"]:
            tool_str = f.get("tool") or "unknown"
            turn_str = f" (turn {f['turn']})" if f.get("turn") is not None else ""
            lines.append(f"- `{f['path']}` — {tool_str}{turn_str}")
        lines.append("")

    # Tools used
    if detail["tools"]:
        tool_strs = [f"{name} ×{count}" for name, count in sorted(detail["tools"].items(), key=lambda x: -x[1])]
        lines.append("### Tools Used")
        lines.append(", ".join(tool_strs))
        lines.append("")

    # Refs
    if detail["refs"]:
        lines.append("### References")
        for r in detail["refs"]:
            lines.append(f"- {r['type']}: {r['value']}")
        lines.append("")

    md_content = "\n".join(lines)
    return PlainTextResponse(content=md_content, media_type="text/markdown")


# ── Recurring templates ───────────────────────────────────────────────────────

@app.get("/api/templates")
async def get_templates() -> dict:
    return {"builtIn": state_mod.BUILT_IN_TEMPLATES, "active": state_mod.recurring_templates}


class TemplateBody(BaseModel):
    title: str | None = None
    id: str | None = None


@app.post("/api/templates/activate")
async def activate_template(body: TemplateBody) -> dict:
    tpl = next((t for t in state_mod.BUILT_IN_TEMPLATES if t["title"] == body.title), None)
    if not tpl:
        raise HTTPException(404, "Template not found")
    return state_mod.activate_template(tpl)


@app.post("/api/templates/deactivate")
async def deactivate_template(body: TemplateBody) -> dict:
    rec = state_mod.deactivate_template(body.id or "")
    if not rec:
        raise HTTPException(404, "Not found")
    return rec


class CreateTemplateBody(BaseModel):
    title: str
    icon: str = "repeat"
    intervalMin: int = 30
    description: str = ""


@app.post("/api/templates/create", status_code=201)
async def create_template(body: CreateTemplateBody) -> dict:
    if not body.title:
        raise HTTPException(400, "title required")
    if body.intervalMin < 1:
        raise HTTPException(400, "intervalMin must be >= 1")
    try:
        return state_mod.create_custom_template(
            title=body.title,
            icon=body.icon,
            interval_min=body.intervalMin,
            description=body.description,
        )
    except ValueError as e:
        raise HTTPException(409, str(e))


# ── File upload → MarkItDown ──────────────────────────────────────────────────

def _markitdown_available() -> bool:
    try:
        import markitdown  # noqa: F401
        return True
    except ImportError:
        return False


def _convert_file(file_path: str) -> str:
    """Convert a file to Markdown using the markitdown library directly.

    Using the library avoids the MCP stdio subprocess whose anyio cancel
    scopes leak into uvicorn's lifespan and crash the server.
    """
    try:
        from markitdown import MarkItDown
        md = MarkItDown()
        result = md.convert(file_path)
        return result.text_content
    except Exception as e:
        raise RuntimeError(f"MarkItDown conversion failed: {e}") from e


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)) -> dict:
    ext = Path(file.filename or "").suffix
    with telem.tracer.start_as_current_span("file.upload") as span:
        span.set_attribute("file.ext", ext)
        span.set_attribute("file.name", file.filename or "unknown")

        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name
        try:
            md = await asyncio.to_thread(_convert_file, tmp_path)
            return {"markdown": md, "filename": file.filename}
        except Exception as e:
            raise HTTPException(500, str(e))
        finally:
            Path(tmp_path).unlink(missing_ok=True)


# ── Extract tasks ─────────────────────────────────────────────────────────────

@app.post("/api/extract")
async def extract_tasks(request: Request) -> StreamingResponse:
    body = await request.json()
    text = body.get("text", "")
    if not text:
        raise HTTPException(400, "text required")

    async def _stream():
        with telem.tracer.start_as_current_span("extract.tasks") as span:
            span.set_attribute("gen_ai.system", "foundry-local")
            span.set_attribute("gen_ai.request.model", agent_mod.MODEL_ID)
            span.set_attribute("input.length", len(text))
            yield _sse({"type": "delta", "delta": "Analyzing..."})
            start = time.time()

            sys_prompt = (
                "You extract tasks from text. Return ONLY a JSON array of objects with:\n"
                "- \"title\": concise task description\n"
                "- \"dueDate\": \"YYYY-MM-DD\" or null\n"
                "- \"dueTime\": \"HH:MM\" or null\n\n"
                f"Today is {datetime.now(timezone.utc).strftime('%Y-%m-%d')}. Convert relative dates to absolute.\n"
                "Extract ALL actionable items — explicit and implicit. No preamble, just the JSON array."
            )

            # Context budget check: chunk large inputs
            budget = get_input_budget(
                agent_mod.MODEL_CONTEXT.get("maxInputTokens"),
                agent_mod.MODEL_CONTEXT.get("maxOutputTokens"),
            )
            sys_tokens = count_tokens(sys_prompt)
            user_tokens = count_tokens(text)
            chunk_budget = (budget - sys_tokens - 64) if budget else None  # 64 token pad

            all_tasks: list[dict] = []
            chunks = split_into_chunks(text, chunk_budget) if chunk_budget and user_tokens > chunk_budget else [text]

            if len(chunks) > 1:
                span.add_event("context.chunked", {"chunk_count": len(chunks), "total_tokens": user_tokens, "model": agent_mod.MODEL_ID})

            for chunk in chunks:
                raw = await _foundry_complete(sys_prompt, chunk)
                try:
                    m = re.search(r"\[[\s\S]*\]", raw)
                    if m:
                        all_tasks.extend(json.loads(m.group(0)))
                except Exception:
                    pass

            # Deduplicate by normalized title
            seen: set[str] = set()
            unique: list[dict] = []
            for t in all_tasks:
                key = (t.get("title") or "").strip().lower()
                if key and key not in seen:
                    seen.add(key)
                    unique.append(t)

            added = [state_mod.add_todo(t["title"], t.get("dueDate"), t.get("dueTime"), "extracted") for t in unique if t.get("title")]
            elapsed = int((time.time() - start) * 1000)
            span.set_attribute("tasks.count", len(added))
            yield _sse({"type": "tasks_extracted", "tasks": added})
            yield _sse({"type": "done"})

    return StreamingResponse(_stream(), media_type="text/event-stream")


# ── Transcribe audio ──────────────────────────────────────────────────────────

_whisper_model = None
_whisper_lock: asyncio.Lock | None = None
# Tracks the alias the currently-loaded _whisper_model corresponds to. When the
# user changes their preferred Whisper variant via Settings / mic popover, we
# clear _whisper_model so the next request lazy-loads the new variant.
_whisper_loaded_alias: str | None = None

# Live streaming ASR via Nemotron — different model than Whisper because Whisper
# does not support push-PCM live transcription. See research notes in
# session-state research/ on this branch for the full justification.
LIVE_MODEL_ALIAS = "nemotron-speech-streaming-en-0.6b"
DEFAULT_WHISPER_ALIAS = "whisper-tiny"

_live_model = None
_live_lock: asyncio.Lock | None = None
# Single concurrent /api/transcribe/live session per process. Whisper and
# Nemotron can't reliably cohabit GPU memory on low-VRAM machines, and a
# second concurrent session would interleave PCM into the same native handle.
# Implementation note: a bare asyncio.Lock isn't sufficient because awaiting
# ws.accept() between the locked() check and acquire() would let two
# connections both pass the check, then queue serially on the lock instead
# of the second one being immediately rejected. We use a guard lock + boolean
# active flag pattern so check-and-set is atomic (no await between them).
_live_ws_guard: asyncio.Lock | None = None
_live_ws_active: bool = False


def _get_whisper_alias() -> str:
    """Return the user's chosen Whisper variant alias, defaulting to whisper-tiny.

    Read from app_config at every call so changes via /api/config take effect
    on the next lazy-load without requiring a process restart.
    """
    cfg = app_config.get("speech") or {}
    alias = (cfg.get("whisperModel") or "").strip() or DEFAULT_WHISPER_ALIAS
    return alias


async def reset_whisper_client() -> None:
    """Drop the cached Whisper model so the next request lazy-loads a new one.

    Called when the user picks a different Whisper variant. Unloads the
    current model on its own thread to free VRAM/RAM before the new one loads.
    """
    global _whisper_model, _whisper_loaded_alias, _whisper_lock
    if _whisper_lock is None:
        _whisper_lock = asyncio.Lock()
    async with _whisper_lock:
        if _whisper_model is not None:
            old = _whisper_model
            _whisper_model = None
            _whisper_loaded_alias = None
            try:
                await asyncio.to_thread(old.unload)
                logger.info("Unloaded Whisper variant: %s", old.id)
            except Exception as exc:
                logger.warning("Whisper unload failed (non-fatal): %s", exc)


def _device_from_model_id(model_id: str | None) -> str | None:
    """Heuristic: map a loaded Foundry variant id to NPU/GPU/CPU for the UI.

    Mirrors the chat-model logic in _health_data(). Foundry variant ids
    embed the runtime (e.g. ``Whisper-Tiny-CUDA``, ``whisper-tiny-cpu``,
    ``...vitis-npu``, ``...migraphx-gpu``).
    """
    if not model_id:
        return None
    s = model_id.lower()
    if "npu" in s or "vitis" in s:
        return "NPU"
    if "gpu" in s or "migraphx" in s or "cuda" in s:
        return "GPU"
    return "CPU"


# Cached precondition: does the catalog actually have the live tier model?
# Set lazily on first /api/health call once foundry_ready is true. Forward-
# looking signal so the UI can grey out the Live engine option when the user's
# Foundry Local catalog hasn't rolled out nemotron yet (see research notes).
# None = not yet probed; True/False = cached result.
_live_tier_available: bool | None = None


def _check_live_tier_available() -> bool:
    """One-shot catalog probe for nemotron-speech-streaming-en-0.6b."""
    global _live_tier_available
    if _live_tier_available is not None:
        return _live_tier_available
    if not agent_mod.foundry_ready:
        return False
    try:
        manager = agent_mod.get_fl_manager()
        model = manager.catalog.get_model(LIVE_MODEL_ALIAS)
        _live_tier_available = model is not None
    except Exception as exc:
        logger.debug("Live tier catalog probe failed (treating as unavailable): %s", exc)
        _live_tier_available = False
    return _live_tier_available


async def _get_whisper_client(progress_cb=None):
    """Lazy-load the user's chosen Whisper variant and return its AudioClient.

    Args:
        progress_cb: Optional ``Callable[[float], None]`` invoked from the
            FFI thread with download percent (0–100). Ignored if the model
            is already cached or already loaded.
    """
    global _whisper_model, _whisper_lock, _whisper_loaded_alias
    if _whisper_lock is None:
        _whisper_lock = asyncio.Lock()
    desired_alias = _get_whisper_alias()
    if _whisper_model is not None and _whisper_loaded_alias == desired_alias:
        return _whisper_model.get_audio_client()
    async with _whisper_lock:
        if _whisper_model is not None and _whisper_loaded_alias == desired_alias:
            return _whisper_model.get_audio_client()
        # Variant changed since last load — unload before swapping.
        if _whisper_model is not None and _whisper_loaded_alias != desired_alias:
            try:
                await asyncio.to_thread(_whisper_model.unload)
                logger.info("Unloaded prior Whisper variant: %s", _whisper_model.id)
            except Exception as exc:
                logger.warning("Prior Whisper unload failed (non-fatal): %s", exc)
            _whisper_model = None
            _whisper_loaded_alias = None
        manager = agent_mod.get_fl_manager()
        model = await asyncio.to_thread(lambda: manager.catalog.get_model(desired_alias))
        if model is None:
            raise RuntimeError(f"{desired_alias} model not found in catalog")
        if not model.is_cached:
            if progress_cb is not None:
                await asyncio.to_thread(lambda: model.download(progress_cb))
            else:
                await asyncio.to_thread(model.download)
        await asyncio.to_thread(model.load)
        _whisper_model = model
        _whisper_loaded_alias = desired_alias
        logger.info("Whisper model loaded: %s (alias=%s)", model.id, desired_alias)
        return model.get_audio_client()


async def _get_live_audio_client(progress_cb=None):
    """Lazy-load the Nemotron streaming ASR model and return its AudioClient.

    The returned client is reusable; each live transcription opens its own
    short-lived ``LiveAudioTranscriptionSession`` against it.
    """
    global _live_model, _live_lock
    if _live_lock is None:
        _live_lock = asyncio.Lock()
    if _live_model is not None:
        return _live_model.get_audio_client()
    async with _live_lock:
        if _live_model is not None:
            return _live_model.get_audio_client()
        manager = agent_mod.get_fl_manager()
        model = await asyncio.to_thread(lambda: manager.catalog.get_model(LIVE_MODEL_ALIAS))
        if model is None:
            raise RuntimeError(
                f"{LIVE_MODEL_ALIAS} model not found in catalog. "
                "Live dictation requires the Nemotron streaming model."
            )
        if not model.is_cached:
            if progress_cb is not None:
                await asyncio.to_thread(lambda: model.download(progress_cb))
            else:
                await asyncio.to_thread(model.download)
        await asyncio.to_thread(model.load)
        _live_model = model
        logger.info("Live ASR model loaded: %s", model.id)
        return model.get_audio_client()


_MAX_AUDIO_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB


@app.post("/api/transcribe", tags=["Speech"])
async def transcribe_audio(
    audio: UploadFile = File(...),
):
    """Transcribe audio using on-device Whisper model (non-streaming)."""
    if not agent_mod.foundry_ready:
        raise HTTPException(503, "Foundry not ready")

    # Validate content type
    content_type = audio.content_type or ""
    if not content_type.startswith("audio/"):
        raise HTTPException(400, f"Expected audio file, got {content_type}")

    suffix = Path(audio.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        total = 0
        while chunk := await audio.read(8192):
            total += len(chunk)
            if total > _MAX_AUDIO_UPLOAD_BYTES:
                tmp_path = tmp.name
                Path(tmp_path).unlink(missing_ok=True)
                raise HTTPException(413, f"Audio file too large (max {_MAX_AUDIO_UPLOAD_BYTES // (1024*1024)}MB)")
            tmp.write(chunk)
        tmp_path = tmp.name

    try:
        audio_client = await _get_whisper_client()
        audio_client.settings.language = "en"
        result = await asyncio.to_thread(audio_client.transcribe, tmp_path)
        text = result.text.strip()

        span = trace.get_current_span()
        span.add_event("speech.transcribed", {"length": len(text), "audio_size": total})

        return {"text": text}
    except Exception as exc:
        logger.exception("Transcription failed: %s", exc)
        raise HTTPException(500, f"Transcription failed: {exc}")
    finally:
        Path(tmp_path).unlink(missing_ok=True)


# ── Streaming transcribe (SSE) ────────────────────────────────────────────────

@app.post("/api/transcribe/stream", tags=["Speech"])
async def transcribe_audio_stream(
    audio: UploadFile = File(...),
):
    """Transcribe an uploaded audio file with SSE-streamed Whisper chunks.

    Wraps ``audio_client.transcribe_streaming(path)`` — the canonical Foundry
    Local pattern as of the 2026 SDK. Yields one ``{"type":"chunk","text":...}``
    per Whisper chunk and a final ``{"type":"done","text":"<full>"}``.
    """
    if not agent_mod.foundry_ready:
        raise HTTPException(503, "Foundry not ready")

    content_type = audio.content_type or ""
    if not content_type.startswith("audio/"):
        raise HTTPException(400, f"Expected audio file, got {content_type}")

    suffix = Path(audio.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        total = 0
        while chunk := await audio.read(8192):
            total += len(chunk)
            if total > _MAX_AUDIO_UPLOAD_BYTES:
                tmp_path = tmp.name
                Path(tmp_path).unlink(missing_ok=True)
                raise HTTPException(413, f"Audio file too large (max {_MAX_AUDIO_UPLOAD_BYTES // (1024*1024)}MB)")
            tmp.write(chunk)
        tmp_path = tmp.name

    async def _stream():
        full_text_parts: list[str] = []
        with telem.tracer.start_as_current_span("speech.transcribe.stream") as span:
            span.set_attribute("audio.size_bytes", total)
            try:
                audio_client = await _get_whisper_client()
                audio_client.settings.language = "en"

                loop = asyncio.get_event_loop()
                chunk_q: asyncio.Queue = asyncio.Queue()
                _SENTINEL = object()

                def _drain_to_queue() -> None:
                    try:
                        for resp in audio_client.transcribe_streaming(tmp_path):
                            loop.call_soon_threadsafe(chunk_q.put_nowait, resp.text)
                    except Exception as exc:
                        loop.call_soon_threadsafe(chunk_q.put_nowait, exc)
                    finally:
                        loop.call_soon_threadsafe(chunk_q.put_nowait, _SENTINEL)

                drain_task = asyncio.create_task(asyncio.to_thread(_drain_to_queue))

                while True:
                    item = await chunk_q.get()
                    if item is _SENTINEL:
                        break
                    if isinstance(item, Exception):
                        raise item
                    if item:
                        full_text_parts.append(item)
                        yield _sse({"type": "chunk", "text": item})

                await drain_task
                full_text = "".join(full_text_parts).strip()
                span.add_event("speech.transcribed", {"length": len(full_text), "audio_size": total})
                yield _sse({"type": "done", "text": full_text})
            except Exception as exc:
                logger.exception("Streaming transcription failed: %s", exc)
                span.record_exception(exc)
                yield _sse({"type": "error", "message": str(exc)})
            finally:
                Path(tmp_path).unlink(missing_ok=True)

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        # Defensive cleanup: even if the SSE generator never reaches its
        # finally (e.g. client disconnects before iteration starts, or the
        # generator is garbage-collected without aclose), Starlette will
        # invoke this background task once the response is closed.
        background=BackgroundTask(lambda: Path(tmp_path).unlink(missing_ok=True)),
    )


# ── Speech model warmup (SSE) ─────────────────────────────────────────────────

class _WarmupRequest(BaseModel):
    model: str = "whisper"  # "whisper" | "live"


@app.post("/api/speech/warmup", tags=["Speech"])
async def warmup_speech_model(body: _WarmupRequest) -> StreamingResponse:
    """Stream download + load progress for a speech model.

    The frontend triggers this in the background after ``foundryReady`` so
    the first mic press doesn't pay the multi-MB download tax silently.
    Idempotent: if the model is already loaded, emits a single
    ``{"type":"done"}`` event.
    """
    target = body.model.lower()
    if target not in ("whisper", "live"):
        raise HTTPException(400, "model must be 'whisper' or 'live'")
    if not agent_mod.foundry_ready:
        raise HTTPException(503, "Foundry not ready")

    async def _stream():
        with telem.tracer.start_as_current_span("speech.warmup") as span:
            span.set_attribute("speech.model", target)
            already = (target == "whisper" and _whisper_model is not None) or \
                      (target == "live" and _live_model is not None)
            if already:
                yield _sse({"type": "done", "model": target, "cached": True})
                return

            loop = asyncio.get_event_loop()
            progress_q: asyncio.Queue = asyncio.Queue()

            def _on_progress(pct: float):
                loop.call_soon_threadsafe(progress_q.put_nowait, pct)

            try:
                if target == "whisper":
                    load_task = asyncio.create_task(_get_whisper_client(progress_cb=_on_progress))
                else:
                    load_task = asyncio.create_task(_get_live_audio_client(progress_cb=_on_progress))

                last_pct = -1.0
                while not load_task.done():
                    try:
                        pct = await asyncio.wait_for(progress_q.get(), timeout=0.5)
                        if pct - last_pct >= 1:
                            yield _sse({"type": "progress", "model": target, "pct": round(pct, 1)})
                            last_pct = pct
                    except asyncio.TimeoutError:
                        pass
                await load_task
                yield _sse({"type": "done", "model": target, "cached": False})
            except Exception as exc:
                logger.exception("Speech warmup failed for %s: %s", target, exc)
                span.record_exception(exc)
                yield _sse({"type": "error", "model": target, "message": str(exc)})

    return StreamingResponse(_stream(), media_type="text/event-stream")


# ── Live transcription (WebSocket) ────────────────────────────────────────────
#
# Why WebSocket instead of SSE? This endpoint needs bidirectional binary
# (PCM frames upstream) plus JSON downstream (interim/final transcripts),
# which SSE cannot do. The rest of taskbean uses SSE for "everything
# complex" — this is the documented exception.
#
# Protocol:
#   server → text: {"type":"loading", "pct": 0..100}            (during download)
#   server → text: {"type":"ready",   "model": str, "device": str}
#   client → binary: raw 16-kHz mono Int16-LE PCM (any chunk size)
#   client → text:   {"type":"stop"}                             (or just close)
#   server → text: {"type":"chunk",  "text": str, "isFinal": bool}
#   server → text: {"type":"done",   "text": str}                (full transcript)
#   server → text: {"type":"error",  "message": str}             (then close)

@app.websocket("/api/transcribe/live")
async def transcribe_live(ws: WebSocket) -> None:
    global _live_ws_guard, _live_ws_active
    if _live_ws_guard is None:
        _live_ws_guard = asyncio.Lock()

    await ws.accept()

    # Atomic check-and-set of the single-session flag. The guard lock has no
    # awaits between check and set, so two concurrent connects cannot both
    # pass the busy check (which was the BLOCKER race in the prior version).
    async with _live_ws_guard:
        if _live_ws_active:
            try:
                await ws.send_json({"type": "error", "code": "busy", "message": "Another live session is already active."})
            finally:
                await ws.close(code=4090)
            return
        _live_ws_active = True

    try:
        if not agent_mod.foundry_ready:
            await ws.send_json({"type": "error", "code": "not_ready", "message": "Foundry not ready"})
            await ws.close(code=4503)
            return

        with telem.tracer.start_as_current_span("speech.live.session") as span:
            span.set_attribute("speech.model.alias", LIVE_MODEL_ALIAS)
            loop = asyncio.get_event_loop()
            session = None
            try:
                # Surface download/load progress before the session can start.
                if _live_model is None:
                    progress_q: asyncio.Queue = asyncio.Queue()

                    def _on_progress(pct: float):
                        loop.call_soon_threadsafe(progress_q.put_nowait, pct)

                    load_task = asyncio.create_task(_get_live_audio_client(progress_cb=_on_progress))
                    last_pct = -1.0
                    while not load_task.done():
                        try:
                            pct = await asyncio.wait_for(progress_q.get(), timeout=0.5)
                            if pct - last_pct >= 1:
                                await ws.send_json({"type": "loading", "pct": round(pct, 1)})
                                last_pct = pct
                        except asyncio.TimeoutError:
                            pass
                    audio_client = await load_task
                else:
                    audio_client = await _get_live_audio_client()

                device = _device_from_model_id(_live_model.id if _live_model else None)
                await ws.send_json({"type": "ready", "model": _live_model.id if _live_model else LIVE_MODEL_ALIAS, "device": device})

                # Start the live session on the audio client. Chunks arrive via
                # the SDK's own background thread; we bridge them to the WS.
                session = audio_client.create_live_transcription_session()
                session.settings.sample_rate = 16000
                session.settings.channels = 1
                session.settings.bits_per_sample = 16
                session.settings.language = "en"
                await asyncio.to_thread(session.start)

                full_text_parts: list[str] = []
                stop_event = asyncio.Event()
                _SENTINEL = object()
                transcript_q: asyncio.Queue = asyncio.Queue()

                def _drain_transcripts() -> None:
                    try:
                        for result in session.get_transcription_stream():
                            text = result.content[0].text if result.content else ""
                            if text:
                                loop.call_soon_threadsafe(
                                    transcript_q.put_nowait,
                                    {"text": text, "isFinal": bool(getattr(result, "is_final", False))},
                                )
                    except Exception as exc:
                        loop.call_soon_threadsafe(transcript_q.put_nowait, exc)
                    finally:
                        loop.call_soon_threadsafe(transcript_q.put_nowait, _SENTINEL)

                drain_task = asyncio.create_task(asyncio.to_thread(_drain_transcripts))

                async def _forward_transcripts() -> None:
                    while True:
                        item = await transcript_q.get()
                        if item is _SENTINEL:
                            return
                        if isinstance(item, Exception):
                            await ws.send_json({"type": "error", "message": str(item)})
                            return
                        full_text_parts.append(item["text"])
                        await ws.send_json({"type": "chunk", "text": item["text"], "isFinal": item["isFinal"]})

                forward_task = asyncio.create_task(_forward_transcripts())

                async def _consume_client() -> None:
                    while not stop_event.is_set():
                        msg = await ws.receive()
                        if msg.get("type") == "websocket.disconnect":
                            stop_event.set()
                            return
                        if "bytes" in msg and msg["bytes"] is not None:
                            # Push PCM straight to the SDK on its own thread to
                            # avoid blocking the event loop on the FFI call.
                            data = msg["bytes"]
                            await asyncio.to_thread(session.append, data)
                        elif "text" in msg and msg["text"] is not None:
                            try:
                                payload = json.loads(msg["text"])
                            except Exception:
                                continue
                            if payload.get("type") == "stop":
                                stop_event.set()
                                return

                consume_task = asyncio.create_task(_consume_client())
                done, pending = await asyncio.wait(
                    {consume_task, forward_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                # Either client said stop / disconnected, or the transcript
                # stream ended unexpectedly. Either way, finalize cleanly.
                for t in pending:
                    t.cancel()

                # Stop the live session on its own thread (drains remaining audio).
                if session is not None:
                    await asyncio.to_thread(session.stop)
                await drain_task

                full_text = "".join(full_text_parts).strip()
                try:
                    await ws.send_json({"type": "done", "text": full_text})
                except Exception:
                    pass
                span.set_attribute("speech.transcript.length", len(full_text))
            except WebSocketDisconnect:
                # Client went away mid-session; just clean up.
                pass
            except Exception as exc:
                logger.exception("Live transcription session failed: %s", exc)
                span.record_exception(exc)
                try:
                    await ws.send_json({"type": "error", "message": str(exc)})
                except Exception:
                    pass
            finally:
                if session is not None:
                    try:
                        await asyncio.to_thread(session.stop)
                    except Exception:
                        pass
                try:
                    await ws.close()
                except Exception:
                    pass
    finally:
        # Release the single-session slot atomically.
        async with _live_ws_guard:
            _live_ws_active = False


# ── Process speech ────────────────────────────────────────────────────────────

@app.post("/api/process-speech")
async def process_speech(request: Request) -> dict:
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text is required")
    if not agent_mod.model_ready:
        hint = agent_mod.startup_error or "Model still initializing — try again in a moment."
        raise HTTPException(503, hint)

    with telem.tracer.start_as_current_span("speech.process") as span:
        span.set_attribute("gen_ai.system", "foundry-local")
        span.set_attribute("gen_ai.request.model", agent_mod.MODEL_ID)
        span.set_attribute("input.length", len(text))
        start = time.time()

        sys_prompt = (
            "You are a task-extraction engine for a speech-to-text todo app.\n"
            "The input is a verbatim speech transcript…\n\n"
            "Extract every actionable item and return ONLY a valid JSON array.\n"
            "Each element: {\"title\", \"priority\": \"high\"|\"medium\"|\"low\", \"tags\": [...], \"dueDate\", \"dueTime\"}\n"
            f"Today is {datetime.now(timezone.utc).strftime('%Y-%m-%d')}. "
            "If no actionable items, return []."
        )

        budget = get_input_budget(
            agent_mod.MODEL_CONTEXT.get("maxInputTokens"),
            agent_mod.MODEL_CONTEXT.get("maxOutputTokens"),
        )
        if budget:
            sys_tokens = count_tokens(sys_prompt)
            user_tokens = count_tokens(text)
            if sys_tokens + user_tokens > budget:
                text, _ = truncate_to_budget(text, budget - sys_tokens)
                span.add_event("context.truncated", {"original_tokens": user_tokens, "model": agent_mod.MODEL_ID})

        raw = await _foundry_complete(sys_prompt, text)
        tasks: list[dict] = []
        m = re.search(r"\[[\s\S]*\]", raw)
        if m:
            try:
                tasks = json.loads(m.group(0))
            except Exception:
                raise HTTPException(500, detail={"error": "Failed to parse model output", "raw": raw})

        added = []
        for t in tasks:
            if not isinstance(t, dict) or not t.get("title"):
                continue
            todo = state_mod.add_todo(t["title"].strip(), t.get("dueDate"), t.get("dueTime"), "speech")
            todo["priority"] = t.get("priority", "medium") if t.get("priority") in ("high", "medium", "low") else "medium"
            todo["tags"] = [str(x) for x in t.get("tags", [])] if isinstance(t.get("tags"), list) else []
            added.append(todo)

        span.set_attribute("tasks.count", len(added))
        return {"success": True, "tasks": added}


# ── Suggestions ───────────────────────────────────────────────────────────────

def _get_time_of_day() -> str:
    from tools import _get_tz
    h = datetime.now(tz=_get_tz()).hour
    if h < 6:
        return "night"
    if h < 12:
        return "morning"
    if h < 17:
        return "afternoon"
    if h < 21:
        return "evening"
    return "night"


class SuggestContext(BaseModel):
    trigger: str = "idle"
    lastTodoTitle: str = ""
    todoCount: int = 0
    pendingCount: int = 0
    timeOfDay: str = ""
    categories: str = ""


class SuggestBody(BaseModel):
    context: SuggestContext | None = None


@app.post("/api/suggest")
async def suggest(body: SuggestBody) -> dict:
    if not agent_mod.model_ready:
        return {"suggestions": []}

    ctx = body.context or SuggestContext()
    trigger = ctx.trigger or "idle"
    todo_count = ctx.todoCount or len(state_mod.todos)
    pending_count = ctx.pendingCount or sum(1 for t in state_mod.todos if not t.get("completed"))
    last_todo = ctx.lastTodoTitle or ""
    time_of_day = ctx.timeOfDay or _get_time_of_day()
    categories = ctx.categories or ""

    todo_list = "\n".join(
        f'- [{"x" if t.get("completed") else " "}] {t["title"]}'
        f'{" (due: " + t["dueDate"] + ")" if t.get("dueDate") else ""}'
        for t in state_mod.todos[:10]
    ) or "(empty list)"

    active_recurring = "\n".join(
        f'- {r.get("icon", "🔁")} {r["title"]} (every {r.get("intervalMin", "?")}m)'
        for r in state_mod.recurring_templates if r.get("active")
    ) or "(none active)"

    builtin_inactive = "\n".join(
        f'- {b.get("icon", "🔁")} {b["title"]} ({b["intervalMin"]}m) — {b.get("description", "")}'
        for b in state_mod.BUILT_IN_TEMPLATES
        if not any(r["title"] == b["title"] and r.get("active") for r in state_mod.recurring_templates)
    ) or "(all enabled)"

    sys_prompt = f"""You generate quick suggestion chips for a todo app. Return ONLY a JSON array of 2-4 suggestions.

Each suggestion: {{ "label": "emoji + short text (max 4 words)", "message": "the full command to send to the AI assistant" }}

Context:
- Trigger: {trigger}
- Time: {time_of_day}
- Total todos: {todo_count}, Pending: {pending_count}
{f'- Last added: "{last_todo}"' if last_todo else ''}
{f'- Active categories: {categories}' if categories else ''}

Current todos:
{todo_list}

Active recurring reminders:
{active_recurring}

Available built-in recurring reminders (not yet enabled):
{builtin_inactive}

Rules:
- If trigger is "onboarding" (empty list): suggest getting started (plan my day, add first task, what's the weather)
- If trigger is "thematic" and lastTodo is set: suggest 2-3 related items in the same category
- If trigger is "completion": suggest next actions or celebration
- If trigger is "recurring_recommendations": suggest 2-3 recurring reminders to enable or create
- If trigger is "idle" + morning: suggest planning the day
- If trigger is "idle" + evening: suggest reviewing what's done
- If trigger is "idle" + general: suggest organizing, adding reminders, or fun tasks
- Keep labels SHORT (emoji + 2-4 words). Messages should be natural language commands.
- Be creative, helpful, and slightly playful.

Return ONLY the JSON array, no other text."""

    try:
        raw = await _foundry_complete(sys_prompt, f'Generate suggestions for trigger="{trigger}"')
        match = re.search(r"\[[\s\S]*\]", raw)
        suggestions = json.loads(match.group(0)) if match else []
        suggestions = [
            {"label": str(s.get("label", ""))[:40], "message": str(s.get("message", ""))[:200]}
            for s in suggestions
            if s.get("label") and s.get("message")
        ][:4]
        return {"suggestions": suggestions}
    except Exception:
        return {"suggestions": []}


# ── Notifications ─────────────────────────────────────────────────────────────

@app.post("/api/test-notification")
async def test_notification() -> dict:
    send_notification("It works! 🎉", "Desktop notifications are ready.", force=True)
    return {
        "success": True,
        "notification": {
            "title": "It works! 🎉",
            "body": "Browser notifications are ready.",
            "url": "/",
        },
    }


# ── Protocol handler registration ─────────────────────────────────────────────

@app.post("/api/register-protocol")
async def register_protocol() -> dict:
    """Register the taskbean:// protocol handler in the current-user registry."""
    launch_ps1 = str(Path(__file__).parent.parent / "launch.ps1")
    command_value = (
        f'powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "{launch_ps1}" "%1"'
    )
    ps_script = (
        "New-Item -Path 'HKCU:\\Software\\Classes\\taskbean' -Force | Out-Null; "
        "Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\taskbean' -Name '(Default)' -Value 'URL:TaskBean Protocol'; "
        "New-ItemProperty -Path 'HKCU:\\Software\\Classes\\taskbean' -Name 'URL Protocol' -Value '' -Force | Out-Null; "
        "New-Item -Path 'HKCU:\\Software\\Classes\\taskbean\\shell\\open\\command' -Force | Out-Null; "
        f"Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\taskbean\\shell\\open\\command' -Name '(Default)' -Value '{command_value}'"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True,
            timeout=15,
            text=True,
        )
        if result.returncode != 0:
            logging.getLogger(__name__).error("Protocol registration PowerShell error: %s", result.stderr.strip())
            return {"success": False, "registered": False, "error": result.stderr.strip()}
        return {"success": True, "registered": True}
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as e:
        logging.getLogger(__name__).error("Protocol registration failed: %s", e)
        return {"success": False, "registered": False, "error": str(e)}


@app.get("/api/protocol-status")
async def protocol_status() -> dict:
    """Check whether the taskbean:// protocol handler is registered."""
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Test-Path 'HKCU:\\Software\\Classes\\taskbean\\shell\\open\\command'"],
            capture_output=True,
            timeout=10,
            text=True,
        )
        registered = result.stdout.strip().lower() == "true"
        return {"registered": registered}
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return {"registered": False}


# ── Telemetry ─────────────────────────────────────────────────────────────────

@app.get("/api/telemetry/snapshot")
async def telemetry_snapshot(limit: int = 50) -> dict:
    return {"events": telem.snapshot(min(limit, 200)), "serverTime": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}


@app.get("/api/telemetry/stream")
async def telemetry_stream(request: Request) -> StreamingResponse:
    async def _stream():
        # Emit initial health snapshot through the ring buffer so it gets a proper ts field
        health = _health_data()
        telem._push_event({"id": telem._next_seq(), "ts": telem._now_iso(), **health})
        # Re-read it back from the buffer so we yield the version with ts/id
        initial = telem.snapshot(1)
        yield _sse(initial[0] if initial else health)
        q = telem.subscribe()
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15)
                    yield _sse(event)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            telem.unsubscribe(q)

    return StreamingResponse(_stream(), media_type="text/event-stream")


@app.post("/api/telemetry/clear")
async def telemetry_clear():
    """Clear the in-memory telemetry event buffer."""
    if telem._ui_span_exporter is not None:
        telem._ui_span_exporter.buffer.clear()
    return {"ok": True}


# ── Jaeger trace proxy───────────────────────────────────────────────────────

@app.get("/api/traces")
async def get_traces(limit: int = 20, service: str = "taskbean"):
    """Proxy to Jaeger v3 Query API — avoids CORS issues for the native trace viewer."""
    jaeger_url = "http://localhost:16686"
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            # Jaeger v3 API
            r = await client.get(
                f"{jaeger_url}/api/v3/traces",
                params={"query.service_name": service, "query.num_traces": limit},
            )
            if r.status_code == 200:
                data = r.json()
                traces = _transform_jaeger_traces(data)
                return JSONResponse({"traces": traces})
            # Fallback to v2 API
            r = await client.get(
                f"{jaeger_url}/api/traces",
                params={"service": service, "limit": limit},
            )
            r.raise_for_status()
            data = r.json()
            traces = _transform_jaeger_v2_traces(data)
            return JSONResponse({"traces": traces})
    except Exception as exc:
        return JSONResponse({"traces": [], "error": str(exc)}, status_code=200)


@app.get("/api/traces/{trace_id}")
async def get_trace(trace_id: str):
    """Fetch a single trace from Jaeger."""
    import re
    if not re.match(r'^[0-9a-fA-F]{1,32}$', trace_id):
        return JSONResponse({"trace": None, "error": "Invalid trace ID format"}, status_code=400)
    jaeger_url = "http://localhost:16686"
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{jaeger_url}/api/traces/{trace_id}")
            r.raise_for_status()
            data = r.json()
            traces = _transform_jaeger_v2_traces(data)
            return JSONResponse({"trace": traces[0] if traces else None})
    except Exception as exc:
        return JSONResponse({"trace": None, "error": str(exc)}, status_code=200)


def _transform_jaeger_v2_traces(data: dict) -> list[dict]:
    """Transform Jaeger v2 API response to simplified trace format for the UI."""
    traces = []
    for trace_data in data.get("data", []):
        trace_id = trace_data.get("traceID", "")
        spans_raw = trace_data.get("spans", [])

        # Build parent map for depth calculation
        parent_map: dict[str, str] = {}
        for s in spans_raw:
            for ref in s.get("references", []):
                if ref.get("refType") == "CHILD_OF":
                    parent_map[s["spanID"]] = ref["spanID"]

        def get_depth(span_id: str) -> int:
            depth = 0
            current = span_id
            visited = set()
            while current in parent_map and current not in visited and depth < 100:
                visited.add(current)
                depth += 1
                current = parent_map[current]
            return depth

        # Sort by start time
        spans_raw.sort(key=lambda s: s.get("startTime", 0))

        spans = []
        for s in spans_raw:
            start_us = s.get("startTime", 0)
            duration_us = s.get("duration", 0)
            spans.append({
                "spanId": s.get("spanID", ""),
                "operationName": s.get("operationName", ""),
                "name": s.get("operationName", ""),
                "startTimeMs": start_us / 1000,
                "durationMs": round(duration_us / 1000, 1),
                "startTime": datetime.fromtimestamp(start_us / 1e6, tz=timezone.utc).isoformat(),
                "depth": get_depth(s.get("spanID", "")),
                "tags": {t["key"]: t["value"] for t in s.get("tags", [])},
            })

        traces.append({
            "traceId": trace_id,
            "spans": spans,
        })
    return traces


def _transform_jaeger_traces(data: dict) -> list[dict]:
    """Transform Jaeger v3 (OTLP) API response. Falls back to v2 format if needed."""
    resource_spans = data.get("result", {}).get("resourceSpans", data.get("resourceSpans", []))
    if not resource_spans:
        return _transform_jaeger_v2_traces(data)

    traces_map: dict[str, list] = {}
    for rs in resource_spans:
        for scope_span in rs.get("scopeSpans", []):
            for span in scope_span.get("spans", []):
                trace_id = span.get("traceId", "")
                if trace_id not in traces_map:
                    traces_map[trace_id] = []

                start_ns = int(span.get("startTimeUnixNano", 0))
                end_ns = int(span.get("endTimeUnixNano", 0))
                traces_map[trace_id].append({
                    "spanId": span.get("spanId", ""),
                    "operationName": span.get("name", ""),
                    "name": span.get("name", ""),
                    "startTimeMs": start_ns / 1e6,
                    "durationMs": round((end_ns - start_ns) / 1e6, 1),
                    "startTime": datetime.fromtimestamp(start_ns / 1e9, tz=timezone.utc).isoformat() if start_ns else "",
                    "depth": 0,  # Would need parent analysis
                    "tags": {a.get("key", ""): _otlp_attr_value(a.get("value", {})) for a in span.get("attributes", [])},
                })

    return [{"traceId": tid, "spans": sorted(spans, key=lambda s: s["startTimeMs"])} for tid, spans in traces_map.items()]


def _otlp_attr_value(val: dict) -> Any:
    """Extract value from OTLP AnyValue."""
    for key in ("stringValue", "intValue", "doubleValue", "boolValue"):
        if key in val:
            return val[key]
    return str(val)


# ── Frontend / SPA fallback ───────────────────────────────────────────────────
# Serve index.html at "/" and all static PWA assets (manifest.json, sw.js,
# icons/*) at their natural root paths. Any unmatched path returns index.html
# so the SPA can handle client-side routing.

@app.get("/", include_in_schema=False)
async def root():
    from fastapi.responses import FileResponse
    index = _PUBLIC / "index.html"
    if index.exists():
        return FileResponse(str(index), headers={"Cache-Control": "no-cache"})
    return JSONResponse({"status": "ok", "message": "Foundry Todo Agent running"})


@app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str):
    from fastapi.responses import FileResponse
    candidate = _PUBLIC / full_path
    if candidate.is_file():
        # Serve sw.js with no-cache so browser always checks for updates
        headers = {"Cache-Control": "no-cache"} if full_path == "sw.js" else {}
        return FileResponse(str(candidate), headers=headers)
    # Fall back to index.html for SPA client-side routes
    index = _PUBLIC / "index.html"
    if index.exists():
        return FileResponse(str(index), headers={"Cache-Control": "no-cache"})
    return JSONResponse({"detail": "Not found"}, status_code=404)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"



# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8275, reload=False)
