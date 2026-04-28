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

from agent_framework import Agent, ChatOptions, Content, ToolResultCompactionStrategy
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


def _model_ep(model: Any) -> str:
    """Return the execution provider a model requires, e.g.
    ``CPUExecutionProvider`` or ``VitisAIExecutionProvider``.

    Returns the empty string if the EP can't be determined; callers should
    treat that as "skip this model" since they can't know if it's safe.
    """
    info = getattr(model, "info", None)
    runtime = getattr(info, "runtime", None) if info else None
    return getattr(runtime, "execution_provider", "") if runtime else ""


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
        # Capture the result so we can filter cached models below.
        logger.info("Registering execution providers…")
        await asyncio.to_thread(manager.download_and_register_eps)
        # Build the set of EPs that are actually usable. CPU and WebGPU are
        # always built in. discover_eps returns explicit EPs (VitisAI, QNN,
        # MIGraphX, TensorRT, etc.) with their current registration state.
        registered_eps = {"CPUExecutionProvider", "WebGpuExecutionProvider"}
        try:
            for ep in await asyncio.to_thread(manager.discover_eps):
                if ep.is_registered:
                    registered_eps.add(ep.name)
        except Exception as exc:
            logger.warning("Failed to enumerate execution providers: %s", exc)
        logger.info("Registered execution providers: %s", sorted(registered_eps))
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

        if model is None:
            # No explicit preference — pick the best cached (downloaded) model
            # whose execution provider is actually registered. Without this
            # filter, cached[0] can land on an NPU model when the VitisAI EP
            # failed to register, leaving the agent unusable until manual
            # intervention. EP filter is a necessary first cut; the smoke
            # test in /api/models/switch is the real readiness check.
            cached = await asyncio.to_thread(
                lambda: list(manager.catalog.get_cached_models())
            )
            compatible = [
                m for m in cached
                if _model_ep(m) in registered_eps
            ]
            if compatible:
                model = compatible[0]
                logger.info(
                    "Auto-selected cached model: %s (ep=%s)",
                    model.alias, _model_ep(model),
                )
                if len(compatible) < len(cached):
                    skipped = [m.alias for m in cached if m not in compatible]
                    logger.info(
                        "Skipped %d cached model(s) with unregistered EPs: %s",
                        len(skipped), skipped,
                    )
            elif cached:
                # Cached models exist but none are EP-compatible — log a
                # clear warning so the user knows to restore the EP (e.g.
                # via Foundry-Local#558 PowerShell cleanup) or download a
                # CPU/GPU model.
                ep_summary = sorted({_model_ep(m) for m in cached})
                raise RuntimeError(
                    f"No cached models compatible with registered EPs "
                    f"{sorted(registered_eps)}. Cached models require: {ep_summary}. "
                    "Either restore the missing execution provider or download "
                    "a CPU/GPU model variant."
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


# Qwen3 ships in "thinking mode" by default — the model emits a long
# <think>…</think> block before its actual answer. On a CPU backend with
# taskbean's full agent payload that pushes inference past the smoke-test
# budget and makes everyday chat painfully slow. The Qwen3 chat template
# honors two off-switches; we set both as belt-and-suspenders so it works
# regardless of whether Foundry Local forwards chat_template_kwargs to the
# tokenizer:
#   1. extra_body: chat_template_kwargs.enable_thinking = false
#      (vLLM-style runtime hook — proper way)
#   2. "/no_think" system-prompt prefix
#      (text-level branch in the Qwen3 chat template — works even if the
#       runtime drops chat_template_kwargs)
def is_qwen3_model(model_id: str | None) -> bool:
    """Return True for Qwen3-family models that default to thinking mode."""
    return bool(model_id) and "qwen3" in model_id.lower()


# Sentinel system message that Qwen3's chat template intercepts to disable
# the <think>…</think> reasoning block.
QWEN3_NO_THINK_PREFIX = "/no_think"


def qwen3_extra_body(model_id: str | None) -> dict[str, Any]:
    """Return the OpenAI ``extra_body`` payload that disables Qwen3 thinking.

    Empty dict for non-Qwen3 models so callers can unconditionally merge.
    """
    if not is_qwen3_model(model_id):
        return {}
    return {"chat_template_kwargs": {"enable_thinking": False}}


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

    **Known limitation: NPU models often crash Foundry on agent payloads.**
    Foundry NPU runtimes (VitisAI, QNN) crash when handed a request with the
    full system prompt + 10-tool definition list — see
    https://github.com/microsoft/Foundry-Local/issues/506. The crash kills
    Foundry's HTTP server, which in turn drops our connection and causes
    httpx.RemoteProtocolError. The `_smoke_test_inference` in main.py probes
    this BEFORE declaring a model switch successful, using the exact same
    payload shape (full instructions + ALL_TOOLS). NPU models that can't
    handle the agent payload get rolled back at switch time with a clear
    error message instead of silently dying on the first chat. CPU and GPU
    models are unaffected.
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

    def _prepare_options(self, messages, options):  # type: ignore[override]
        """Inject Qwen3-specific runtime kwargs into the OpenAI request body.

        ``OpenAI.chat.completions.create`` merges ``extra_body`` into the JSON
        sent to the server, so attaching ``chat_template_kwargs`` here gets it
        all the way through to the Foundry/ONNX-Runtime tokenizer that decides
        whether to emit a ``<think>`` block. No-op for non-Qwen3 models.
        """
        opts = super()._prepare_options(messages, options)
        extra = qwen3_extra_body(self.model)
        if extra:
            existing = opts.get("extra_body") or {}
            # Deep-merge chat_template_kwargs in case caller already set some.
            merged_ctk = dict(existing.get("chat_template_kwargs") or {})
            merged_ctk.update(extra["chat_template_kwargs"])
            opts["extra_body"] = {**existing, "chat_template_kwargs": merged_ctk}
        return opts

    def _inner_get_response(  # type: ignore[override]
        self,
        *,
        messages,
        options,
        stream: bool = False,
        **kwargs,
    ):
        """Translate streaming requests into a non-streaming Foundry call.

        Foundry Local's ``/v1/chat/completions`` with ``stream=true`` reliably
        drops the connection mid-response when called from the long-running
        FastAPI/uvicorn server (httpx surfaces this as
        ``RemoteProtocolError: peer closed connection``). The non-streaming
        path works perfectly. We can't disable streaming at the AG-UI layer
        (``run_agent_stream`` always passes ``stream=True``), so we translate
        it here: when streaming is requested, we call Foundry with
        ``stream=False``, then synthesize a single ``ChatCompletionChunk``
        that wraps the full response and feed it through the parent's
        ``_parse_response_update_from_openai`` so the rest of the framework
        sees a normal-looking stream of one chunk.

        Trade-off: the user sees the response appear all at once after
        generation completes, instead of token-by-token. This is acceptable
        for a tool-calling agent (where most "tokens" are JSON arguments
        that aren't shown to the user anyway) and unblocks all chat
        functionality.

        Couples us to ``agent_framework_openai._chat_completion_client``
        internals (``_inner_get_response``, ``_parse_response_update_from_openai``,
        ``_build_response_stream``). Pin the framework version. Revisit when
        Foundry-Local#422 is fixed and remove this override if so.
        """
        # Strip the AG-UI auto-injected state-context system message before
        # ANY downstream processing. AG-UI's _create_state_context_message
        # dumps the full client state dict (in our case ~75k chars of todo
        # JSON) as a system message on every turn. The model already has a
        # compact view via _build_instructions(), and tools mutate state
        # directly, so the injection is redundant — and on small-context
        # models (qwen2.5-coder-0.5b: 32k tokens) it blows the context
        # window and Foundry returns HTTP 500.
        messages = [m for m in messages if not _is_agui_state_context(m)]

        # Qwen3 thinking-mode suppression: prepend a standalone /no_think
        # system message. The marker only triggers Qwen3's chat-template
        # branch when it's the *entire* content of a system message —
        # embedding it inside the main instruction message is silently
        # ignored. We do this here (vs. in build_agent's instructions)
        # because the framework adds instructions as one combined system
        # message, which won't trigger the chat-template hook.
        if is_qwen3_model(self.model):
            from agent_framework import Message as _AfMessage
            messages = [_AfMessage("system", [QWEN3_NO_THINK_PREFIX]), *list(messages)]

        if not stream:
            return super()._inner_get_response(
                messages=messages, options=options, stream=False, **kwargs
            )

        # Streaming requested — fold to non-streaming and synthesize one
        # chunk so the rest of agent-framework sees what it expects.
        # Trade-off: we bypass the parent's ChatTelemetryLayer wrapping
        # (chat <model> spans), so AI response telemetry is reduced for
        # this path. The lower-level FunctionInvocationLayer telemetry
        # (tool execution spans) still fires. Future work: wrap our raw
        # call in the same span so the nerd panel sees AI events too.
        async def _fake_stream():
            options_dict = self._prepare_options(messages, options)
            options_dict.pop("stream_options", None)
            try:
                completion = await self.client.chat.completions.create(
                    stream=False, **options_dict
                )
            except Exception as ex:
                from agent_framework.exceptions import ChatClientException
                if isinstance(ex, ChatClientException):
                    raise
                raise ChatClientException(
                    f"{type(self)} service failed to complete the prompt: {ex}",
                    inner_exception=ex,
                ) from ex
            chunk = _completion_to_chunk(completion)
            yield self._parse_response_update_from_openai(chunk)

        return self._build_response_stream(
            _fake_stream(), response_format=options.get("response_format")
        )


def _is_agui_state_context(message) -> bool:
    """Detect AG-UI's auto-injected ``Current state of the application:``
    system message so we can strip it before sending to Foundry.

    Belt-and-suspenders: the prefix is unique to AG-UI's
    ``_create_state_context_message`` helper so the prefix check alone is
    very unlikely to false-positive. We also require the message be
    suspiciously large (> 1 KB) to make absolutely sure we never strip a
    legitimate user-or-app-authored system message that happens to start
    with the same words. AG-UI's real injection is typically 75k+ chars
    (full state JSON), so 1 KB is a comfortably low bar.
    """
    if getattr(message, "role", None) != "system":
        return False
    for content in getattr(message, "contents", None) or []:
        text = getattr(content, "text", None)
        if (
            isinstance(text, str)
            and text.startswith("Current state of the application:")
            and len(text) > 1024
        ):
            return True
    return False


def _completion_to_chunk(completion):
    """Convert a non-streaming ``ChatCompletion`` to a ``ChatCompletionChunk``.

    The chunk preserves all fields the agent-framework parser cares about:
    role, content, tool_calls, finish_reason, and usage. Used by
    ``_NormalizingChatClient._inner_get_response`` to make a non-streaming
    response look like a one-event stream.
    """
    from openai.types.chat import ChatCompletionChunk
    from openai.types.chat.chat_completion_chunk import (
        Choice,
        ChoiceDelta,
        ChoiceDeltaToolCall,
        ChoiceDeltaToolCallFunction,
    )

    chunk_choices = []
    for choice in completion.choices:
        msg = choice.message
        delta_tool_calls = None
        if msg.tool_calls:
            delta_tool_calls = [
                ChoiceDeltaToolCall(
                    index=i,
                    id=tc.id,
                    type=tc.type,
                    function=ChoiceDeltaToolCallFunction(
                        name=tc.function.name,
                        arguments=tc.function.arguments,
                    ),
                )
                for i, tc in enumerate(msg.tool_calls)
            ]
        delta = ChoiceDelta(
            role=msg.role,
            content=msg.content,
            tool_calls=delta_tool_calls,
        )
        chunk_choices.append(
            Choice(
                index=choice.index,
                delta=delta,
                finish_reason=choice.finish_reason,
            )
        )

    return ChatCompletionChunk(
        id=completion.id,
        choices=chunk_choices,
        created=completion.created,
        model=completion.model,
        object="chat.completion.chunk",
        usage=completion.usage,
    )


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

    # tool_choice="auto" lets the model decide; the system prompt and tool
    # descriptions (with negative guidance + enum constraints) steer selection.
    # Use "required" only for models that don't produce structured tool_calls
    # natively (e.g., phi-4-mini NPU) — see research/tool-calling findings.
    default_opts = ChatOptions(tool_choice="auto")

    agent = Agent(
        client=client,
        instructions=_build_instructions(),
        name="todo-assistant",
        tools=ALL_TOOLS,
        compaction_strategy=compaction,
        default_options=default_opts,
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
        # predict_state_config is NOT used here because taskbean's tools
        # append/modify items in a list, while predictive state uses
        # "replace" operations. Using it with add_task would replace the
        # entire todos array with the title string, corrupting client state.
        # STATE_SNAPSHOT after tool execution correctly reflects mutations.
        require_confirmation=False,
    )

    _agent_singleton = agent
    _agui_singleton = ag_ui_agent
    return agent, ag_ui_agent


class DynamicAgentProxy(AgentFrameworkAgent):
    """Proxy that delegates to the current _agui_singleton.

    ``add_agent_framework_fastapi_endpoint()`` captures the agent once at
    registration time. Since taskbean rebuilds the agent on every model
    switch, we need a stable proxy object that resolves the real singleton
    at call time. This subclass overrides ``run()`` to delegate.
    """

    def __init__(self):
        # Don't call super().__init__() — we don't have an agent yet.
        # The proxy resolves the real AgentFrameworkAgent at run time.
        pass

    async def run(self, input_data: dict[str, Any]):
        inst = _agui_singleton
        if inst is None:
            raise RuntimeError("Agent not yet initialized — call initialize_foundry() first")
        async for event in inst.run(input_data):
            yield event


# Single proxy instance — passed to add_agent_framework_fastapi_endpoint()
agent_proxy = DynamicAgentProxy()


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

    base = f"""You are a todo list assistant. Current time: {current_time} ({_tz_name}). Today: {today}.

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

    # NB: do NOT prefix with /no_think here. Qwen3's chat template only
    # intercepts the marker when it's the *entire* content of a dedicated
    # system message — prefixed inside a longer instruction it gets ignored
    # and the model falls back to thinking mode. The marker is injected
    # separately by callers via prepend_qwen3_no_think_message().
    return base


def prepend_qwen3_no_think_message(messages: list[dict], model_id: str | None) -> list[dict]:
    """Prepend a standalone ``/no_think`` system message for Qwen3 models.

    Qwen3's chat template intercepts ``/no_think`` only when it's the whole
    content of a system message; embedding it inside the main instruction
    is silently ignored. Returns the original list unchanged for non-Qwen3
    models so callers can call this unconditionally.
    """
    if not is_qwen3_model(model_id):
        return messages
    return [{"role": "system", "content": QWEN3_NO_THINK_PREFIX}, *messages]
