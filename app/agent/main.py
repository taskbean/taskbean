"""FastAPI application — replaces server.js with Python backend.

Endpoints mirror the original Node.js server:
  GET  /api/health
  GET  /api/models
  POST /api/models/switch      (SSE)
  GET  /api/todos
  PATCH /api/todos/:id
  DELETE /api/todos/:id
  GET  /api/projects
  GET  /api/projects/tasks
  GET  /api/copilot-usage
  GET  /api/templates
  POST /api/templates/activate
  POST /api/templates/deactivate
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
from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from opentelemetry import trace

import telemetry as telem
import state as state_mod
import app_config
import hardware as hw_mod
import recommender
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
        cmd_value = f'powershell.exe -ExecutionPolicy Bypass -NoProfile -File "{launch_ps1}" "%1"'
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
    yield  # server is running
    await shutdown_foundry()


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
        return response

app.add_middleware(SecurityHeadersMiddleware)

# Serve the existing frontendfrom ../public
_PUBLIC = Path(__file__).parent.parent / "public"

# ── AG-UI command endpoint ─────────────────────────────────────────────────────

from ag_ui.core import RunErrorEvent
from ag_ui.encoder import EventEncoder
from agent_framework_ag_ui import AGUIRequest

# Agent is built inside initialize_foundry() after the model loads.
# Do NOT call build_agent() here — MODEL_ID and SERVICE_BASE_URL are still
# empty at module-load time, which would create a broken agent pointed at
# an invalid URL (http://127.0.0.1:0/v1).


@app.post("/api/command", tags=["AG-UI"], response_model=None)
async def command_endpoint(request_body: AGUIRequest) -> StreamingResponse:
    """AG-UI SSE endpoint — dynamically delegates to the current _agui_singleton
    so that model switches take effect without re-registering routes."""
    input_data = request_body.model_dump(exclude_none=True)
    state = input_data.setdefault("state", {})
    for key, value in {
        "todos": state_mod.todos,
        "recurringTemplates": state_mod.recurring_templates,
    }.items():
        if key not in state:
            state[key] = copy.deepcopy(value)

    user_msg = ""
    msgs = input_data.get("messages", [])
    for m in reversed(msgs):
        if m.get("role") == "user":
            content = m.get("content", "")
            user_msg = content if isinstance(content, str) else str(content)[:200]
            break
    span = trace.get_current_span()
    span.set_attribute("flow", "command")
    span.set_attribute("input_length", len(user_msg))
    start = time.time()

    async def _event_generator():
        encoder = EventEncoder()
        try:
            inst = agent_mod._agui_singleton
            if inst is None:
                raise RuntimeError("Agent not yet initialized")
            async for event in inst.run(input_data):
                yield encoder.encode(event)
            elapsed = int((time.time() - start) * 1000)
            span.set_attribute("duration_ms", elapsed)
            span.set_attribute("gen_ai.system", "foundry-local")
            span.set_attribute("gen_ai.request.model", agent_mod.MODEL_ID)
        except BaseException as exc:
            logger.exception("Agent error during /api/command: %s", exc)
            span.set_status(trace.StatusCode.ERROR, str(exc)[:200])
            span.record_exception(exc)
            try:
                yield encoder.encode(RunErrorEvent(
                    message=f"{type(exc).__name__}: {str(exc)[:300]}",
                    code=type(exc).__name__,
                ))
            except Exception:
                pass

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


_instructions_lock = asyncio.Lock()


@app.middleware("http")
async def refresh_instructions_middleware(request: Request, call_next):
    """Refresh agent instructions before each /api/command request so the
    agent always sees the current time and latest todo list.

    Uses a lock so that concurrent requests cannot interleave instruction
    mutations on the shared singleton.
    """
    if request.url.path == "/api/command":
        async with _instructions_lock:
            refresh_agent_instructions()
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

async def _npu_usage_sampler() -> None:
    """Poll Windows PDH 'GPU Engine' counters filtered to NPU LUID every 3 seconds."""
    global _npu_usage_percent
    # Wait for hardware detection to complete (lazy, runs on first /api/config)
    await asyncio.sleep(5)
    hw = hw_mod.detect_hardware()
    if not hw.npu or not hw.npu.luid:
        logger.info("NPU LUID not available — NPU usage sampler disabled")
        return

    luid = hw.npu.luid
    counter_filter = rf"\GPU Engine(pid_*_luid_{luid}*)\Utilization Percentage"
    ps_cmd = (
        f"(Get-Counter '{counter_filter}' -ErrorAction SilentlyContinue).CounterSamples "
        f"| Measure-Object -Property CookedValue -Sum | Select-Object -ExpandProperty Sum"
    )
    logger.info("NPU usage sampler started for LUID %s", luid)

    while True:
        try:
            result = await asyncio.to_thread(
                subprocess.run,
                ["powershell", "-NoProfile", "-Command", ps_cmd],
                capture_output=True, text=True, timeout=8,
            )
            if result.returncode == 0:
                val = result.stdout.strip()
                try:
                    _npu_usage_percent = min(100.0, max(0.0, round(float(val), 1)))
                except (ValueError, TypeError):
                    _npu_usage_percent = 0.0
            else:
                _npu_usage_percent = 0.0
        except Exception as e:
            logger.debug("NPU sampler error: %s", e)
        await asyncio.sleep(3)


# ── Health ────────────────────────────────────────────────────────────────────

def _health_data() -> dict[str, Any]:
    return {
        "type": "health.snapshot",
        "model": agent_mod.MODEL_ID,
        "serviceUrl": agent_mod.SERVICE_BASE_URL,
        "foundryReady": agent_mod.foundry_ready,
        "modelReady": agent_mod.model_ready,
        "startupError": agent_mod.startup_error,
        "mcpAvailable": _markitdown_available(),
        "uptimeMs": int(time.time() * 1000) - telem.SERVER_START,
    }


def _hardware_snapshot() -> dict[str, Any]:
    """Live hardware snapshot with CPU/RAM/NPU usage."""
    hw = hw_mod.detect_hardware()
    hw_dict = hw.to_dict()
    # Enrich with live metrics
    try:
        import psutil
        hw_dict["cpu"]["usagePercent"] = psutil.cpu_percent(interval=None)
        mem = psutil.virtual_memory()
        hw_dict["ram"] = {
            "totalGb": round(mem.total / (1024 ** 3), 1),
            "usedGb": round(mem.used / (1024 ** 3), 1),
            "freeGb": round(mem.available / (1024 ** 3), 1),
            "usagePercent": round(mem.percent, 1),
        }
    except ImportError:
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


@app.get("/api/hardware")
async def hardware_snapshot() -> dict:
    return _hardware_snapshot()


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
                else "Other"
            )
            param_match = re.search(r"[_-](\d+\.?\d*)\s*b\b", alias, re.I)
            device = info.runtime.device_type if info.runtime else None
            device_str = device.upper() if device else "CPU"
            result.append({
                "alias": alias,
                "modelId": m.id,
                "device": device_str,
                "fileSizeGb": round(info.file_size_mb / 1024, 2) if info.file_size_mb else None,
                "paramBillions": float(param_match.group(1)) if param_match else None,
                "family": family,
                "tasks": ["chat", "tools"] if info.supports_tool_calling else ["chat"],
                "toolCalling": bool(info.supports_tool_calling),
                "license": info.license or "",
                "contextLength": info.context_length,
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
            else "Other"
        )
        models.append({
            "alias": current_alias,
            "modelId": model_id,
            "device": device_norm,
            "fileSizeGb": file_size_gb,
            "paramBillions": param_billions,
            "family": family,
            "tasks": [t.strip() for t in tasks.split(",") if t.strip()],
            "toolCalling": "tools" in tasks.lower() or "tool" in tasks.lower(),
            "license": license_,
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
            # contextLength and maxOutputTokens come from the catalog entry itself
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


def _sync_startup_shortcut(enabled: bool) -> None:
    """Create or remove a Windows Startup folder shortcut for launch.ps1."""
    launch_ps1 = str(Path(__file__).parent.parent / "launch.ps1")
    startup_dir = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    shortcut_path = startup_dir / "TaskBean.lnk"
    try:
        if enabled:
            # Create .lnk via WScript.Shell COM
            ps = (
                f"$ws = New-Object -ComObject WScript.Shell; "
                f"$sc = $ws.CreateShortcut('{shortcut_path}'); "
                f"$sc.TargetPath = 'powershell.exe'; "
                f"$sc.Arguments = '-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File \"{launch_ps1}\"'; "
                f"$sc.WorkingDirectory = '{Path(launch_ps1).parent}'; "
                f"$sc.Description = 'TaskBean — start server and open app'; "
                f"$sc.Save()"
            )
            result = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, timeout=10, text=True)
            if result.returncode != 0:
                logging.getLogger(__name__).warning("Startup shortcut creation failed: %s", result.stderr.strip())
            else:
                logging.getLogger(__name__).info("Created startup shortcut at %s", shortcut_path)
        else:
            shortcut_path.unlink(missing_ok=True)
            logging.getLogger(__name__).info("Removed startup shortcut")
    except Exception as e:
        logging.getLogger(__name__).warning("Startup shortcut sync failed: %s", e)


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
        valid_engines = {"auto", "web", "whisper"}
        valid_fallbacks = {"web", "whisper", "none"}
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
        pending["speech"] = current_speech

    # Phase 2: If errors, reject entirely without persisting anything
    if errors:
        raise HTTPException(400, "; ".join(errors))

    # Phase 3: Persist all validated changes
    for key, value in pending.items():
        app_config.set(key, value)

    # Handle side effects after successful persistence
    if "runOnStartup" in pending:
        _sync_startup_shortcut(pending["runOnStartup"])

    return {**app_config.all_settings(), "hardware": hw_mod.detect_hardware().to_dict()}


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

        async def _commit_switch(target_model: Any):
            """Atomically update all module-level state and rebuild the agent."""
            agent_mod.MODEL_ID = target_model.id
            agent_mod.MODEL_ALIAS = target_model.alias
            agent_mod._update_model_context(target_model)
            global _catalog_cache
            _catalog_cache = None
            # Ensure the web service is running (may not be if default model
            # failed at startup).
            await agent_mod._ensure_web_service()
            agent_mod.model_ready = True
            agent_mod.startup_error = None
            agent_mod.build_agent()

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
                yield send("error", {"message": f"Load failed: {exc}"})
                return

            await _commit_switch(target_model)
            span.add_event("switch.done", {"alias": entry["alias"]})
            yield send("done", {"modelId": model_id, "alias": entry["alias"]})

    return StreamingResponse(_stream(), media_type="text/event-stream")


# ── Todo CRUD ─────────────────────────────────────────────────────────────────


@app.get("/api/todos")
async def get_todos() -> list:
    return state_mod.todos


class TodoCreate(BaseModel):
    title: str
    emoji: str | None = None
    dueDate: str | None = None
    dueTime: str | None = None
    priority: str | None = None
    notes: str | None = None
    tags: list[str] | None = None


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


@app.patch("/api/todos/{todo_id}")
async def patch_todo(todo_id: str, patch: TodoPatch) -> dict:
    fields = {k: v for k, v in patch.model_dump(exclude_unset=True).items() if v is not None}
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
    return {"success": True}


# ── Projects (reads from CLI's SQLite DB) ─────────────────────────────────────


def _get_taskbean_db():
    """Open the shared taskbean SQLite DB (read-only)."""
    import sqlite3
    db_path = os.path.join(os.path.expanduser("~"), ".taskbean", "taskbean.db")
    if not os.path.exists(db_path):
        return None
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


@app.get("/api/projects")
async def get_projects() -> list:
    """Return tracked projects from CLI's SQLite DB, merged with in-memory todo counts."""
    conn = _get_taskbean_db()
    if not conn:
        return []
    try:
        rows = conn.execute(
            "SELECT name, path FROM projects WHERE tracked = 1 ORDER BY name"
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
        project_todos = [t for t in state_mod.todos if t.get("project") == name]
        sc = todo_counts.get(name, {"total": 0, "done": 0})
        mem_total = len(project_todos)
        mem_done = sum(1 for t in project_todos if t.get("completed"))
        result.append({
            "name": name,
            "path": r["path"],
            "total": sc["total"] + mem_total,
            "done": sc["done"] + mem_done,
            "pending": (sc["total"] - sc["done"]) + (mem_total - mem_done),
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
                "completed, source, priority, notes, tags, project, created_at as createdAt "
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


# ── Copilot Usage Stats ──────────────────────────────────────────────────────


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


async def _get_whisper_client():
    """Lazy-load whisper-tiny and return its AudioClient."""
    global _whisper_model, _whisper_lock
    if _whisper_lock is None:
        _whisper_lock = asyncio.Lock()
    if _whisper_model is not None:
        return _whisper_model.get_audio_client()
    async with _whisper_lock:
        if _whisper_model is not None:
            return _whisper_model.get_audio_client()
        manager = agent_mod.get_fl_manager()
        model = await asyncio.to_thread(lambda: manager.catalog.get_model("whisper-tiny"))
        if model is None:
            raise RuntimeError("whisper-tiny model not found in catalog")
        if not model.is_cached:
            await asyncio.to_thread(model.download)
        await asyncio.to_thread(model.load)
        _whisper_model = model
        logger.info("Whisper model loaded: %s", model.id)
        return model.get_audio_client()
_MAX_AUDIO_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB


@app.post("/api/transcribe", tags=["Speech"])
async def transcribe_audio(
    audio: UploadFile = File(...),
):
    """Transcribe audio using on-device Whisper model."""
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


# ── Notifications ─────────────────────────────────────────────────────────────

@app.post("/api/test-notification")
async def test_notification() -> dict:
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
        f'powershell.exe -ExecutionPolicy Bypass -NoProfile -File "{launch_ps1}" "%1"'
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


async def _foundry_complete(system: str, user: str) -> str:
    """Single-turn completion via Foundry Local OpenAI-compat API (non-streaming)."""
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": user})

    max_out = agent_mod.MODEL_CONTEXT.get("maxOutputTokens")
    body: dict[str, Any] = {
        "model": agent_mod.MODEL_ID,
        "messages": messages,
        "stream": False,
        "max_tokens": min(2000, max_out) if max_out else 2000,
    }

    span = trace.get_current_span()
    span.set_attribute("gen_ai.system", "foundry-local")
    span.set_attribute("gen_ai.request.model", agent_mod.MODEL_ID)
    span.set_attribute("gen_ai.request.max_tokens", body["max_tokens"])
    span.set_attribute("gen_ai.request.mode", "non-streaming")
    span.set_attribute("gen_ai.input_length", sum(len(m.get("content", "")) for m in messages))
    _fc_start = time.time()

    async with httpx.AsyncClient(timeout=120) as client:
        last_exc: httpx.HTTPStatusError | None = None
        for attempt in range(3):  # 1 initial + 2 retries
            try:
                r = await client.post(f"{agent_mod.SERVICE_BASE_URL}/v1/chat/completions", json=body)
                r.raise_for_status()
                data = r.json()
                break
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code < 500 or attempt >= 2:
                    raise
                last_exc = exc
                delay = attempt + 1  # 1s, 2s
                logger.warning("Foundry 5xx (attempt %d/3), retrying in %ds: %s", attempt + 1, delay, exc)
                span.add_event("ai.retry", {"attempt": attempt + 1, "status": exc.response.status_code, "model": agent_mod.MODEL_ID})
                await asyncio.sleep(delay)
        else:
            raise last_exc  # type: ignore[misc]

    _fc_elapsed = int((time.time() - _fc_start) * 1000)
    usage = data.get("usage", {})
    span.set_attribute("gen_ai.response.duration_ms", _fc_elapsed)
    span.set_attribute("gen_ai.usage.input_tokens", usage.get("prompt_tokens"))
    span.set_attribute("gen_ai.usage.output_tokens", usage.get("completion_tokens"))
    finish_reason = data.get("choices", [{}])[0].get("finish_reason")
    if finish_reason:
        span.set_attribute("gen_ai.response.finish_reason", finish_reason)

    msg = data["choices"][0]["message"]
    if isinstance(msg.get("content"), str):
        return msg["content"]
    if isinstance(msg.get("content"), list):
        return "".join(p.get("text", "") for p in msg["content"] if p.get("type") == "text")
    return ""


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=2326, reload=False)
