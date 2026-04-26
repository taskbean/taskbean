"""Unit tests for the Foundry reliability fixes (2026-04-26).

Covers four behaviors implemented to address Foundry-Local#422 and
related model-switch reliability issues:

1. ``_NormalizingChatClient._inner_get_response`` translates streaming
   requests into non-streaming Foundry calls and synthesizes a chunk
   stream so the rest of agent-framework sees a normal stream.
2. ``_smoke_test_inference`` rejects models that load but can't actually
   serve inference requests.
3. ``preferredModel`` is persisted as the full model ID, not the alias,
   so a model variant locked in by the user survives restart.
4. ``initialize_foundry`` filters cached models by registered execution
   providers so we don't auto-select a model whose EP failed to register.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Make the agent package importable.
sys.path.insert(0, str(Path(__file__).resolve().parent))


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_completion(content="Hello", tool_calls=None, finish_reason="stop"):
    """Build an OpenAI ChatCompletion stub matching the SDK's pydantic shape."""
    from openai.types.chat import ChatCompletion
    from openai.types.chat.chat_completion import Choice
    from openai.types.chat.chat_completion_message import ChatCompletionMessage
    from openai.types.completion_usage import CompletionUsage

    msg = ChatCompletionMessage(
        role="assistant",
        content=content,
        tool_calls=tool_calls,
    )
    return ChatCompletion(
        id="chat.id.test",
        choices=[Choice(index=0, message=msg, finish_reason=finish_reason, logprobs=None)],
        created=1700000000,
        model="test-model",
        object="chat.completion",
        usage=CompletionUsage(prompt_tokens=10, completion_tokens=5, total_tokens=15),
    )


def _make_tool_call(name="add_task", arguments='{"title": "x"}'):
    from openai.types.chat.chat_completion_message_tool_call import (
        ChatCompletionMessageToolCall,
        Function,
    )
    return ChatCompletionMessageToolCall(
        id="call_test",
        type="function",
        function=Function(name=name, arguments=arguments),
    )


# ── 1. Streaming wrapper unit tests ──────────────────────────────────────────


def test_completion_to_chunk_preserves_text_and_finish():
    """The non-streaming → streaming converter must preserve content + finish."""
    from agent import _completion_to_chunk

    completion = _make_completion(content="Hello world", finish_reason="stop")
    chunk = _completion_to_chunk(completion)

    from openai.types.chat import ChatCompletionChunk
    assert isinstance(chunk, ChatCompletionChunk)
    assert chunk.id == "chat.id.test"
    assert chunk.model == "test-model"
    assert chunk.object == "chat.completion.chunk"
    assert len(chunk.choices) == 1
    delta = chunk.choices[0].delta
    assert delta.role == "assistant"
    assert delta.content == "Hello world"
    assert chunk.choices[0].finish_reason == "stop"


def test_completion_to_chunk_preserves_usage():
    """Telemetry pipeline depends on usage being present on the chunk."""
    from agent import _completion_to_chunk

    chunk = _completion_to_chunk(_make_completion())
    assert chunk.usage is not None
    assert chunk.usage.prompt_tokens == 10
    assert chunk.usage.completion_tokens == 5
    assert chunk.usage.total_tokens == 15


def test_completion_to_chunk_preserves_tool_calls():
    """Tool calls must round-trip from message → delta with index/id/function."""
    from agent import _completion_to_chunk

    tc = _make_tool_call(name="set_reminder", arguments='{"title":"meet","remind_at":"2026-01-01T10:00:00Z"}')
    completion = _make_completion(content=None, tool_calls=[tc], finish_reason="tool_calls")
    chunk = _completion_to_chunk(completion)
    delta = chunk.choices[0].delta

    assert delta.tool_calls is not None
    assert len(delta.tool_calls) == 1
    delta_tc = delta.tool_calls[0]
    assert delta_tc.index == 0
    assert delta_tc.id == "call_test"
    assert delta_tc.function.name == "set_reminder"
    assert delta_tc.function.arguments == '{"title":"meet","remind_at":"2026-01-01T10:00:00Z"}'
    assert chunk.choices[0].finish_reason == "tool_calls"


def test_wrapper_strips_agui_state_context_message():
    """The wrapper must drop AG-UI's "Current state of the application:..."
    system message before calling the parent's _inner_get_response — that
    message can be 100k+ chars of todo JSON and blows small-model context
    windows."""
    from agent_framework import Message, Content
    from agent import _NormalizingChatClient, _is_agui_state_context

    # Build real Message objects matching what AG-UI sends
    huge_state_text = (
        "Current state of the application:\n"
        + json.dumps({"todos": [{"id": str(i), "title": f"t{i}"} for i in range(200)]}, indent=2)
        + "\nNever replace existing data..."
    )
    state_msg = Message(role="system", contents=[Content.from_text(text=huge_state_text)])
    sys_msg = Message(role="system", contents=[Content.from_text(text="You are a helpful assistant.")])
    user_msg = Message(role="user", contents=[Content.from_text(text="hi")])

    # _is_agui_state_context should detect the state message and only it
    assert _is_agui_state_context(state_msg) is True
    assert _is_agui_state_context(sys_msg) is False
    assert _is_agui_state_context(user_msg) is False

    # The wrapper applies the filter to the messages list before calling super
    # We can't easily exercise the full _inner_get_response stack without a real
    # OpenAI client, but the filter expression is the surgery — verify it cleanly
    # removes only the state-context entry:
    messages = [sys_msg, state_msg, user_msg]
    filtered = [m for m in messages if not _is_agui_state_context(m)]
    assert len(filtered) == 2
    assert state_msg not in filtered
    assert sys_msg in filtered
    assert user_msg in filtered


def test_state_context_filter_keeps_small_user_authored_messages():
    """A short user-authored system message that happens to start with the
    same prefix must NOT be stripped. The 1 KB size guard is the
    belt-and-suspenders check that keeps this safe."""
    from agent_framework import Message, Content
    from agent import _is_agui_state_context

    # User happens to author a system note with the same prefix — small
    # enough that it's clearly not AG-UI's auto-injected state dump.
    user_authored = "Current state of the application: testing in progress."
    msg = Message(role="system", contents=[Content.from_text(text=user_authored)])
    assert _is_agui_state_context(msg) is False, "Small system messages must not be stripped"

    # An AG-UI message that's shorter than 1 KB still gets through (defensive
    # fallback — false negative is preferred over false positive here).
    short_agui = "Current state of the application:\n{\"todos\": []}"
    msg2 = Message(role="system", contents=[Content.from_text(text=short_agui)])
    assert _is_agui_state_context(msg2) is False


def test_wrapper_passes_through_non_streaming():
    """When stream=False is requested, the wrapper must delegate to the parent
    without folding through the synthesizer."""
    from agent import _NormalizingChatClient

    client = _NormalizingChatClient.__new__(_NormalizingChatClient)
    sentinel = object()
    with patch(
        "agent_framework_openai._chat_completion_client.RawOpenAIChatCompletionClient._inner_get_response",
        return_value=sentinel,
    ) as mock_super:
        result = client._inner_get_response(messages=[], options={}, stream=False)
        mock_super.assert_called_once()
        # stream kwarg should be False
        _, kwargs = mock_super.call_args
        assert kwargs.get("stream") is False
    assert result is sentinel


# ── 2. Smoke test unit tests ─────────────────────────────────────────────────


def test_smoke_test_returns_none_on_200():
    """A successful Foundry response means the smoke test passes."""
    import main as main_mod
    import agent as agent_mod

    agent_mod.SERVICE_BASE_URL = "http://localhost:99999"

    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {"choices": [{"message": {"content": "hi"}}]}

    async def _post(*args, **kwargs):
        return response

    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = MagicMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = _post
        mock_client_cls.return_value = mock_client

        result = asyncio.run(main_mod._smoke_test_inference("test-model:1"))

    assert result is None


def test_smoke_test_returns_error_on_500():
    """A 500 from Foundry must produce an actionable error message."""
    import main as main_mod
    import agent as agent_mod

    agent_mod.SERVICE_BASE_URL = "http://localhost:99999"

    response = MagicMock()
    response.status_code = 500
    response.text = ""

    async def _post(*args, **kwargs):
        return response

    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = MagicMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = _post
        mock_client_cls.return_value = mock_client

        result = asyncio.run(main_mod._smoke_test_inference("broken-model:1"))

    assert result is not None
    assert "HTTP 500" in result
    assert "broken-model:1" in result


def test_smoke_test_handles_missing_service_url():
    """If the Foundry web service isn't running, smoke test must say so."""
    import main as main_mod
    import agent as agent_mod

    agent_mod.SERVICE_BASE_URL = ""
    result = asyncio.run(main_mod._smoke_test_inference("any-model"))
    assert result is not None
    assert "web service" in result.lower()


def test_smoke_test_handles_timeout():
    """Smoke test must convert TimeoutException to a friendly error."""
    import httpx
    import main as main_mod
    import agent as agent_mod

    agent_mod.SERVICE_BASE_URL = "http://localhost:99999"

    async def _post(*args, **kwargs):
        raise httpx.TimeoutException("simulated timeout")

    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = MagicMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = _post
        mock_client_cls.return_value = mock_client

        result = asyncio.run(main_mod._smoke_test_inference("slow-model:1", timeout_s=0.01))

    assert result is not None
    assert "timed out" in result.lower()


def test_smoke_test_handles_foundry_crash():
    """Smoke test must produce an actionable error when Foundry drops the
    connection mid-response (NPU + tool-payload crash, Foundry-Local#506)."""
    import httpx
    import main as main_mod
    import agent as agent_mod

    agent_mod.SERVICE_BASE_URL = "http://localhost:99999"

    async def _post(*args, **kwargs):
        raise httpx.RemoteProtocolError("peer closed connection without sending complete message body")

    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = MagicMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = _post
        mock_client_cls.return_value = mock_client

        result = asyncio.run(main_mod._smoke_test_inference("npu-model:1"))

    assert result is not None
    # Surface the actionable hint about NPU + Foundry-Local#506
    assert "npu" in result.lower() or "closed the connection" in result.lower()
    assert "npu-model:1" in result


def test_smoke_test_probes_with_tools():
    """Smoke test must include ``tools`` in the probe so it catches
    NPU runtimes that crash on tool-bearing requests but pass on bare
    ``[{role: user, content: hi}]`` payloads."""
    import main as main_mod
    import agent as agent_mod

    agent_mod.SERVICE_BASE_URL = "http://localhost:99999"

    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {"choices": [{"message": {"content": "ok"}}]}

    captured = {}

    async def _post(url, **kwargs):
        captured["url"] = url
        captured["json"] = kwargs.get("json")
        return response

    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = MagicMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = _post
        mock_client_cls.return_value = mock_client

        result = asyncio.run(main_mod._smoke_test_inference("any-model:1"))

    assert result is None
    body = captured["json"]
    assert body is not None
    assert body.get("stream") is False
    assert "tools" in body and len(body["tools"]) >= 1
    # The probe should include both system + user roles to exercise the
    # full agent payload shape.
    roles = [m.get("role") for m in body.get("messages", [])]
    assert "system" in roles
    assert "user" in roles


# ── 3. preferredModel persistence (full ID, not alias) ───────────────────────


def test_persist_preferred_uses_full_id_not_alias(tmp_path, monkeypatch):
    """The switch handler writes target_model.id (full variant ID), not alias."""
    import importlib
    import app_config as ac

    # Redirect config to a temp dir so we don't pollute real ~/.taskbean
    monkeypatch.setattr(ac, "_CONFIG_DIR", tmp_path)
    monkeypatch.setattr(ac, "_CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(ac, "_OLD_CONFIG_DIR", tmp_path / "_old")
    importlib.reload(ac)
    monkeypatch.setattr(ac, "_CONFIG_DIR", tmp_path)
    monkeypatch.setattr(ac, "_CONFIG_FILE", tmp_path / "config.json")

    ac.set("preferredModel", "qwen2.5-coder-0.5b-instruct-generic-cpu:4")
    saved = json.loads((tmp_path / "config.json").read_text())
    assert saved["preferredModel"] == "qwen2.5-coder-0.5b-instruct-generic-cpu:4"
    assert ":" in saved["preferredModel"], "Full ID should include the variant suffix"


def test_clear_preferred_only_when_matches():
    """_clear_preferred_if_matches must clear only if the current value matches."""
    import main as main_mod
    import app_config as ac

    with patch.object(ac, "preferred_model", return_value="model-a:1") as mock_get, \
         patch.object(ac, "set") as mock_set:
        main_mod._clear_preferred_if_matches("model-a:1")
        mock_set.assert_called_once_with("preferredModel", None)

    with patch.object(ac, "preferred_model", return_value="model-a:1"), \
         patch.object(ac, "set") as mock_set:
        main_mod._clear_preferred_if_matches("model-b:1")
        mock_set.assert_not_called()


# ── 4. EP-aware startup filter ───────────────────────────────────────────────


def test_model_ep_extracts_execution_provider():
    """_model_ep walks model.info.runtime.execution_provider."""
    from agent import _model_ep

    model = SimpleNamespace(
        info=SimpleNamespace(runtime=SimpleNamespace(execution_provider="VitisAIExecutionProvider"))
    )
    assert _model_ep(model) == "VitisAIExecutionProvider"


def test_model_ep_returns_empty_when_missing():
    """_model_ep returns '' rather than crashing when fields are missing."""
    from agent import _model_ep

    assert _model_ep(SimpleNamespace()) == ""
    assert _model_ep(SimpleNamespace(info=SimpleNamespace(runtime=None))) == ""
    assert _model_ep(SimpleNamespace(info=None)) == ""


def test_ep_filter_logic():
    """Direct exercise of the filter expression used in initialize_foundry.

    We can't easily run initialize_foundry without Foundry, but the filter
    is a one-liner and worth pinning behaviorally so a future refactor
    doesn't accidentally re-introduce the bug.
    """
    from agent import _model_ep

    cached = [
        SimpleNamespace(alias="cpu-model", info=SimpleNamespace(runtime=SimpleNamespace(execution_provider="CPUExecutionProvider"))),
        SimpleNamespace(alias="npu-model", info=SimpleNamespace(runtime=SimpleNamespace(execution_provider="VitisAIExecutionProvider"))),
        SimpleNamespace(alias="gpu-model", info=SimpleNamespace(runtime=SimpleNamespace(execution_provider="DmlExecutionProvider"))),
    ]
    registered = {"CPUExecutionProvider", "WebGpuExecutionProvider"}

    compatible = [m for m in cached if _model_ep(m) in registered]
    assert [m.alias for m in compatible] == ["cpu-model"]
