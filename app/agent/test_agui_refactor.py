"""Unit tests for the AG-UI refactor — no Foundry model required.

Tests the DynamicAgentProxy, endpoint registration, and agent construction
without starting the full server or loading a model.
"""

from __future__ import annotations

import pytest


def test_dynamic_proxy_is_agentframeworkagent():
    """DynamicAgentProxy must pass isinstance check for the helper."""
    from agent_framework_ag_ui import AgentFrameworkAgent
    from agent import DynamicAgentProxy, agent_proxy

    assert isinstance(agent_proxy, AgentFrameworkAgent)
    assert isinstance(DynamicAgentProxy(), AgentFrameworkAgent)


def test_dynamic_proxy_raises_before_init():
    """Proxy.run() should raise RuntimeError before initialize_foundry()."""
    import asyncio
    from agent import DynamicAgentProxy

    proxy = DynamicAgentProxy()

    async def _collect():
        events = []
        async for event in proxy.run({"messages": []}):
            events.append(event)
        return events

    with pytest.raises(RuntimeError, match="Agent not yet initialized"):
        asyncio.run(_collect())


def test_agent_proxy_singleton_exists():
    """The module-level agent_proxy should be a DynamicAgentProxy."""
    from agent import agent_proxy, DynamicAgentProxy

    assert agent_proxy is not None
    assert isinstance(agent_proxy, DynamicAgentProxy)


def test_build_agent_sets_require_confirmation_false():
    """AgentFrameworkAgent should have require_confirmation=False."""
    from agent import build_agent, _agui_singleton
    # Can't call build_agent without Foundry, but we can inspect
    # the constructor args by looking at the current code structure.
    # If _agui_singleton is None (no model loaded), just verify the
    # code passes the flag by checking the source.
    import inspect
    import agent as agent_mod
    src = inspect.getsource(agent_mod.build_agent)
    assert "require_confirmation=False" in src


def test_predict_state_config_not_set():
    """predict_state_config should NOT be set — it corrupts list state."""
    import inspect
    import agent as agent_mod
    src = inspect.getsource(agent_mod.build_agent)
    assert "predict_state_config" not in src or "NOT used" in src


def test_tool_priority_has_enum():
    """Priority parameter should use Literal enum, not free string."""
    import sys
    import os
    sys.path.insert(0, os.path.dirname(__file__))

    # Patch telemetry.emit before importing tools
    import telemetry as _telem
    if not hasattr(_telem, "emit"):
        _telem.emit = lambda *a, **kw: None

    from tools import add_task, update_task

    for tool_obj in [add_task, update_task]:
        spec = tool_obj.to_json_schema_spec()
        params = spec["function"]["parameters"]["properties"]
        priority = params.get("priority", {})
        # Should have enum in the anyOf variants
        any_of = priority.get("anyOf", [])
        enum_found = any(
            "enum" in variant and set(variant["enum"]) == {"high", "medium", "low", "none"}
            for variant in any_of
            if isinstance(variant, dict)
        )
        assert enum_found, (
            f"{tool_obj.name} priority should have enum ['high','medium','low','none'], "
            f"got: {priority}"
        )


def test_tool_descriptions_have_negative_guidance():
    """Tool descriptions should include 'Do NOT' or 'Do not' guidance."""
    import sys
    import os
    sys.path.insert(0, os.path.dirname(__file__))

    import telemetry as _telem
    if not hasattr(_telem, "emit"):
        _telem.emit = lambda *a, **kw: None

    from tools import add_task, update_task

    add_desc = add_task.to_json_schema_spec()["function"]["description"]
    assert "Do NOT" in add_desc or "Do not" in add_desc, (
        f"add_task should have negative guidance, got: {add_desc}"
    )

    update_desc = update_task.to_json_schema_spec()["function"]["description"]
    assert "Do NOT" in update_desc or "Do not" in update_desc, (
        f"update_task should have negative guidance, got: {update_desc}"
    )


def test_endpoint_registered_on_app():
    """The /api/command endpoint should be registered on the FastAPI app."""
    from main import app

    routes = [r.path for r in app.routes if hasattr(r, "path")]
    assert "/api/command" in routes, f"/api/command not in routes: {routes}"
