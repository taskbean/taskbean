"""Agent Framework agent: Foundry Local client + tools + AG-UI state schema."""

from __future__ import annotations
import asyncio
import json
import logging
import re
import sys
import uuid
from typing import Any

# Windows strftime uses %#d to remove leading zeros; POSIX uses %-d.
_DAY_FMT = "%#d" if sys.platform == "win32" else "%-d"

from agent_framework import Agent, Content, ToolResultCompactionStrategy
from agent_framework_openai import OpenAIChatCompletionClient
from agent_framework_ag_ui import AgentFrameworkAgent
from foundry_local_sdk import Configuration, FoundryLocalManager as FLSdk

import state as state_mod
import telemetry as telem
from tools import ALL_TOOLS

logger = logging.getLogger(__name__)

# ── Model state ───────────────────────────────────────────────────────────────

# Full model variant ID resolved at runtime, e.g. "phi-4-mini-instruct-vitis-npu:2"
MODEL_ID: str = ""
# Short alias resolved at runtime, e.g. "phi-4-mini"
MODEL_ALIAS: str = ""
# Base URL of the in-process OpenAI-compatible web service, e.g. "http://127.0.0.1:55588"
SERVICE_BASE_URL: str = ""

foundry_ready: bool = False
model_ready: bool = False
startup_error: str | None = None

# Cached context limits for the active model.
MODEL_CONTEXT: dict[str, int | None] = {"maxInputTokens": None, "maxOutputTokens": None}


# ── SDK helpers ───────────────────────────────────────────────────────────────

def get_fl_manager() -> FLSdk:
    """Return the Foundry Local SDK singleton (raises if not yet initialized)."""
    if FLSdk.instance is None:
        raise RuntimeError("Foundry Local SDK not initialized")
    return FLSdk.instance


def _update_model_context(model: Any) -> None:
    """Cache context-window limits from an IModel instance."""
    MODEL_CONTEXT["maxInputTokens"] = model.context_length
    MODEL_CONTEXT["maxOutputTokens"] = model.info.max_output_tokens
    logger.info(
        "Context limits: input=%s output=%s",
        MODEL_CONTEXT["maxInputTokens"],
        MODEL_CONTEXT["maxOutputTokens"],
    )


# ── Initialization ────────────────────────────────────────────────────────────

async def _ensure_web_service() -> None:
    """Start the in-process OpenAI-compatible REST server if not already running."""
    global SERVICE_BASE_URL
    manager = get_fl_manager()
    if not manager.urls:
        await asyncio.to_thread(manager.start_web_service)
    SERVICE_BASE_URL = manager.urls[0]
    logger.info("Foundry Local web service at %s", SERVICE_BASE_URL)


async def initialize_foundry(
    startup_model: str | None = None,
    preferred_device: str = "auto",
) -> None:
    """Initialize the Foundry Local SDK, load a model, and start the
    in-process OpenAI-compatible web service.

    Parameters
    ----------
    startup_model : str or None
        Alias or full model ID to load. When *None* the SDK picks the
        best cached model for the registered execution providers.
    preferred_device : str
        Device preference ("auto", "npu", "gpu", "cpu"). When a specific
        device is requested and *startup_model* resolves to an alias-level
        model, the matching device variant is selected before loading.

    All blocking SDK calls are dispatched to a thread pool so the FastAPI event
    loop stays responsive during startup.
    """
    global MODEL_ID, MODEL_ALIAS, SERVICE_BASE_URL
    global foundry_ready, model_ready, startup_error

    startup_error = None
    model_ready = False
    foundry_ready = False

    try:
        # Initialize the SDK singleton (idempotent — safe to call on retry).
        if FLSdk.instance is None:
            config = Configuration(app_name="taskbean")
            await asyncio.to_thread(FLSdk.initialize, config)

        manager = FLSdk.instance

        # Download and register hardware execution providers (VITIS/QNN for NPU,
        # CUDA/TensorRT for GPU, etc.). This is a no-op when already registered.
        #
        # The underlying native call is flaky on cold start — individual EP
        # downloads can fail transiently because the Foundry native service
        # isn't fully ready yet. Failures are returned in `failed_eps` rather
        # than raised, so we must check the result and retry with exponential
        # backoff instead of assuming success.
        logger.info("Registering execution providers…")
        ep_result = None
        backoffs = [2, 4, 8, 16, 30]  # seconds; ~60s total if every attempt fails
        for attempt, sleep_s in enumerate(backoffs, start=1):
            try:
                ep_result = await asyncio.to_thread(manager.download_and_register_eps)
            except Exception as e:
                logger.warning("EP registration attempt %d raised: %s", attempt, e)
                ep_result = None
                if attempt < len(backoffs):
                    await asyncio.sleep(sleep_s)
                continue
            failed = list(getattr(ep_result, "failed_eps", []) or [])
            registered = list(getattr(ep_result, "registered_eps", []) or [])
            if not failed:
                logger.info("EPs registered: %s", registered or "(none new)")
                break
            if attempt < len(backoffs):
                logger.warning(
                    "EP registration attempt %d: registered=%s, failed=%s — retrying in %ds",
                    attempt, registered, failed, sleep_s,
                )
                await asyncio.sleep(sleep_s)
            else:
                failed_list = ", ".join(failed)
                logger.error(
                    "EP registration failed after %d attempts: registered=%s, failed=%s. "
                    "Models requiring these EPs will not load.",
                    attempt, registered, failed,
                )
                # In-process retry cannot recover from a wedged native service;
                # surface an actionable message so the UI can offer a restart.
                startup_error = (
                    f"Hardware execution providers failed to register: {failed_list}. "
                    "This is a known Foundry Local cold-start issue — restart taskbean to retry."
                )
        foundry_ready = True
        logger.info("Foundry Local SDK initialized")

        # Start the built-in OpenAI-compatible REST server early so model
        # switches can use it even if the requested model fails to load.
        await _ensure_web_service()

        # Resolve model: try as alias first (SDK picks best variant for
        # registered EPs), then fall back to full model-variant ID.
        model = None
        if startup_model:
            model = await asyncio.to_thread(
                lambda: (manager.catalog.get_model(startup_model)
                         or manager.catalog.get_model_variant(startup_model))
            )
            if model is None:
                logger.warning(
                    "Preferred model '%s' not found in catalog — clearing preference",
                    startup_model,
                )
                # Clear stale preference so the user isn't stuck on restart.
                try:
                    import app_config
                    if app_config.preferred_model() == startup_model:
                        app_config.set("preferredModel", None)
                except Exception:
                    pass
            else:
                # Reject voice/speech preference — those belong to speech.model, not preferredModel.
                _info = getattr(model, "info", None)
                _task = (getattr(_info, "task", "") or "").lower() if _info else ""
                _in_mods = getattr(_info, "input_modalities", "") if _info else ""
                if isinstance(_in_mods, (list, tuple)):
                    _in_mods_str = " ".join(str(x) for x in _in_mods).lower()
                else:
                    _in_mods_str = str(_in_mods).lower()
                _alias_lower = (getattr(model, "alias", "") or "").lower()
                if (
                    "speech" in _task
                    or "audio" in _task
                    or "audio" in _in_mods_str
                    or "whisper" in _alias_lower
                ):
                    logger.warning(
                        "Preferred model '%s' is a voice model — clearing preference and "
                        "falling back to auto-select. Voice models belong to speech.model.",
                        startup_model,
                    )
                    try:
                        import app_config
                        if app_config.preferred_model() == startup_model:
                            app_config.set("preferredModel", None)
                    except Exception:
                        pass
                    model = None

        if model is None:
            # No explicit preference — pick the best cached (downloaded) chat model.
            # Speech models (whisper, etc.) must not be auto-selected as the
            # chat agent — they're set via the Voice tab.
            cached = await asyncio.to_thread(
                lambda: list(manager.catalog.get_cached_models())
            )
            def _is_speech(cached_model) -> bool:
                info = getattr(cached_model, "info", None)
                task = (getattr(info, "task", "") or "").lower() if info else ""
                in_mods = getattr(info, "input_modalities", "") if info else ""
                if isinstance(in_mods, (list, tuple)):
                    in_mods_str = " ".join(str(x) for x in in_mods).lower()
                else:
                    in_mods_str = str(in_mods).lower()
                alias = (getattr(cached_model, "alias", "") or "").lower()
                return (
                    "speech" in task
                    or "audio" in task
                    or "audio" in in_mods_str
                    or "whisper" in alias
                )
            chat_cached = [m for m in cached if not _is_speech(m)]
            if chat_cached:
                model = chat_cached[0]
                logger.info("Auto-selected cached model: %s", model.alias)
            elif cached:
                # Only voice models are cached — can't run chat agent.
                aliases = ", ".join(m.alias for m in cached)
                raise RuntimeError(
                    f"Only voice/speech models are cached ({aliases}). "
                    "Download a chat model first: foundry model download <alias>"
                )
            else:
                raise RuntimeError(
                    "No cached models available. Download a model first: "
                    "foundry model download <alias>"
                )

        # If a specific device is requested, select the matching variant.
        if preferred_device != "auto" and hasattr(model, "variants"):
            target_dev = preferred_device.upper()
            variant = next(
                (v for v in model.variants
                 if v.info.runtime and v.info.runtime.device_type.upper() == target_dev),
                None,
            )
            if variant:
                model.select_variant(variant)
                logger.info("Selected %s variant: %s", target_dev, model.id)
            else:
                logger.warning(
                    "No %s variant for %s — using default: %s",
                    target_dev, model.alias, model.id,
                )

        # Ensure model files are downloaded before loading.
        if not model.is_cached:
            logger.info("Downloading model %s…", model.alias)
            await asyncio.to_thread(model.download)

        logger.info("Loading model %s…", model.alias)
        await asyncio.to_thread(model.load)

        MODEL_ID = model.id
        MODEL_ALIAS = model.alias
        _update_model_context(model)
        logger.info("Model loaded: %s", MODEL_ID)

        model_ready = True
        build_agent()

    except Exception as e:
        # Preserve the earlier EP-registration message if present — it's
        # more actionable ("restart taskbean") than the downstream model-load
        # failure it caused.
        if not startup_error:
            startup_error = str(e)
        logger.warning("Foundry startup incomplete: %s", e)


async def shutdown_foundry() -> None:
    """Gracefully stop the web service on application shutdown."""
    try:
        manager = FLSdk.instance
        if manager and manager.urls:
            await asyncio.to_thread(manager.stop_web_service)
            logger.info("Foundry Local web service stopped")
    except Exception as e:
        logger.warning("Error during Foundry shutdown: %s", e)


# ── Agent construction ────────────────────────────────────────────────────────

# Matches Qwen2.5's native <tool_call>...</tool_call> XML blocks in content.
_TOOL_CALL_RE = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.DOTALL)


class _NormalizingChatClient(OpenAIChatCompletionClient):
    """OpenAIChatCompletionClient that normalises <tool_call> XML into
    structured tool_calls before the agent framework parses them.

    Qwen2.5 (and some other models) emit tool calls as XML in the message
    content instead of OpenAI-structured ``tool_calls``. The Foundry Local
    in-process web service does not translate this XML, so ``FunctionInvocationLayer``
    never sees structured calls and the raw XML leaks into the chat.

    This subclass overrides the two methods called by both the non-streaming
    (``_parse_response_from_openai``) and streaming
    (``_parse_response_update_from_openai``) paths:

    * ``_parse_tool_calls_from_openai``: also scans ``content`` for XML when
      ``tool_calls`` is empty, returning proper ``Content.from_function_call``
      objects so ``FunctionInvocationLayer`` can execute them.
    * ``_parse_text_from_openai``: strips the XML blocks from visible text so
      they don't appear in the chat bubble.

    For models that already return native ``tool_calls`` the XML regex won't
    match, making this a transparent no-op.
    """

    def _parse_tool_calls_from_openai(self, choice):  # type: ignore[override]
        calls = super()._parse_tool_calls_from_openai(choice)
        if calls:
            return calls
        msg = getattr(choice, "message", None) or getattr(choice, "delta", None)
        content = getattr(msg, "content", None) if msg else None
        if not content:
            return []
        results = []
        for raw in _TOOL_CALL_RE.findall(content):
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                logger.debug("Malformed <tool_call> JSON: %s", raw[:200])
                continue
            name = data.pop("name", None)
            if not name:
                continue
            results.append(
                Content.from_function_call(
                    call_id=str(uuid.uuid4()),
                    name=name,
                    arguments=json.dumps(data),
                )
            )
        if results:
            logger.debug("Normalised %d <tool_call> XML block(s) from %s", len(results), MODEL_ALIAS)
        return results

    def _parse_text_from_openai(self, choice):  # type: ignore[override]
        msg = getattr(choice, "message", None) or getattr(choice, "delta", None)
        content = getattr(msg, "content", None) if msg else None
        if content and _TOOL_CALL_RE.search(content):
            stripped = _TOOL_CALL_RE.sub("", content).strip()
            return Content.from_text(text=stripped, raw_representation=choice) if stripped else None
        return super()._parse_text_from_openai(choice)


# Singleton agent instances — reassigned on model switch.
_agent_singleton: Agent | None = None
_agui_singleton: AgentFrameworkAgent | None = None


def build_agent() -> tuple[Agent, AgentFrameworkAgent]:
    """Build (or rebuild) the Agent Framework agent and its AG-UI wrapper.

    Uses OpenAIChatCompletionClient pointed at the new SDK's in-process web
    service. This has the same full middleware stack as FoundryLocalClient
    (FunctionInvocationLayer → ChatMiddlewareLayer → ChatTelemetryLayer →
    RawOpenAIChatCompletionClient) but connects to the native SDK runtime
    instead of the legacy CLI service.

    Called once at startup and again after every model switch.
    """
    global _agent_singleton, _agui_singleton

    if not SERVICE_BASE_URL:
        raise RuntimeError(
            "Cannot build agent: SERVICE_BASE_URL not set. "
            "Call initialize_foundry() first."
        )

    client = _NormalizingChatClient(
        model=MODEL_ID or "pending",
        base_url=f"{SERVICE_BASE_URL}/v1",
        api_key="none",
    )

    # ToolResultCompactionStrategy: keep only the most recent tool-call group
    # in context. Older tool results are replaced with compact summaries,
    # preventing the message history from ballooning across tool rounds.
    compaction = ToolResultCompactionStrategy(keep_last_tool_call_groups=1)

    agent = Agent(
        client=client,
        instructions=_build_instructions(),
        name="todo-assistant",
        tools=ALL_TOOLS,
        compaction_strategy=compaction,
    )

    # State schema shared with the frontend via AG-UI STATE_SNAPSHOT / STATE_DELTA.
    state_schema = {
        "todos": list,
        "recurringTemplates": list,
    }

    ag_ui_agent = AgentFrameworkAgent(
        agent=agent,
        name="Foundry Todo Assistant",
        state_schema=state_schema,
    )

    _agent_singleton = agent
    _agui_singleton = ag_ui_agent
    return agent, ag_ui_agent


def refresh_agent_instructions() -> None:
    """Rebuild system-prompt on the live singleton agent.

    Called by request middleware before each /api/command turn so the agent
    always sees the current time and up-to-date todo list.
    """
    if _agent_singleton is not None:
        _agent_singleton.instructions = _build_instructions()


def _build_instructions() -> str:
    from datetime import datetime
    from zoneinfo import ZoneInfo
    import app_config as _app_config
    _tz_name = _app_config.get("timezone") or "America/Los_Angeles"
    try:
        _tz = ZoneInfo(_tz_name)
    except (KeyError, Exception):
        _tz = ZoneInfo("America/Los_Angeles")
    local_time = datetime.now(tz=_tz)
    current_time = local_time.strftime(f"%A, %B {_DAY_FMT}, %Y at %I:%M %p")
    today = local_time.strftime("%Y-%m-%d")

    todo_list = "\n".join(
        f'- [{"x" if t["completed"] else " "}] "{t["title"]}" '
        f'(id: {t["id"]}'
        f'{", due: " + t["dueDate"] if t.get("dueDate") else ""}'
        f'{" " + t["dueTime"] if t.get("dueTime") else ""}'
        f'{", reminder: " + t["remindAt"] if t.get("reminder") else ""})'
        for t in state_mod.todos
    ) or "(empty)"

    return f"""You are a todo list assistant. Current time: {current_time} ({_tz_name}). Today: {today}.

Todos:
{todo_list}

Rules:
- ALWAYS call a tool immediately for any add/update/delete/reminder request — no preamble.
- add_task: plain task. set_reminder: timed reminder. mark_complete/mark_incomplete/remove_task: updates.
- update_task: change title, due date/time, priority, notes, tags on an existing todo. Use for rename/reschedule/edit requests.
- get_current_datetime: resolve relative times. get_weather: only when weather is asked.
- "leave for work"=5 PM, "morning"=8 AM, "lunch"=12 PM, "tonight"=8 PM.
- Match "done with X"/"finished X" to closest todo title. Never invent IDs.
- For priority: "urgent"/"ASAP"=high, "important"=medium, "whenever"/"low priority"=low.
- After tool calls, reply briefly in plain text. Pure info questions: reply without tools."""
