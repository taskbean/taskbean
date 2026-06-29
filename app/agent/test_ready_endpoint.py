from __future__ import annotations

import json

import pytest


@pytest.fixture(autouse=True)
def stable_health_helpers(monkeypatch):
    import main

    monkeypatch.setattr(main, "_markitdown_available", lambda: False)
    monkeypatch.setattr(main, "_check_live_tier_available", lambda: False)
    monkeypatch.setattr(main, "_whisper_model", None)
    monkeypatch.setattr(main, "_live_model", None)


def _body(response) -> dict:
    return json.loads(response.body.decode("utf-8"))


@pytest.mark.asyncio
async def test_ready_returns_503_while_model_initializes(monkeypatch) -> None:
    import main

    monkeypatch.setattr(main.agent_mod, "foundry_ready", True)
    monkeypatch.setattr(main.agent_mod, "model_ready", False)
    monkeypatch.setattr(main.agent_mod, "startup_error", None)
    monkeypatch.setattr(main.agent_mod, "MODEL_ID", "")
    monkeypatch.setattr(main.agent_mod, "MODEL_ALIAS", "")
    monkeypatch.setattr(main.agent_mod, "SERVICE_BASE_URL", "")

    response = await main.ready()

    assert response.status_code == 503
    assert _body(response)["modelReady"] is False


@pytest.mark.asyncio
async def test_ready_returns_500_when_startup_error_exists(monkeypatch) -> None:
    import main

    monkeypatch.setattr(main.agent_mod, "foundry_ready", True)
    monkeypatch.setattr(main.agent_mod, "model_ready", False)
    monkeypatch.setattr(main.agent_mod, "startup_error", "model load failed")
    monkeypatch.setattr(main.agent_mod, "MODEL_ID", "")
    monkeypatch.setattr(main.agent_mod, "MODEL_ALIAS", "")
    monkeypatch.setattr(main.agent_mod, "SERVICE_BASE_URL", "")

    response = await main.ready()

    assert response.status_code == 500
    assert _body(response)["startupError"] == "model load failed"


@pytest.mark.asyncio
async def test_ready_returns_200_when_model_is_ready(monkeypatch) -> None:
    import main

    monkeypatch.setattr(main.agent_mod, "foundry_ready", True)
    monkeypatch.setattr(main.agent_mod, "model_ready", True)
    monkeypatch.setattr(main.agent_mod, "startup_error", None)
    monkeypatch.setattr(main.agent_mod, "MODEL_ID", "qwen3-0.6b-generic-cpu:4")
    monkeypatch.setattr(main.agent_mod, "MODEL_ALIAS", "qwen3-0.6b")
    monkeypatch.setattr(main.agent_mod, "SERVICE_BASE_URL", "http://127.0.0.1:50588")

    response = await main.ready()

    assert response.status_code == 200
    data = _body(response)
    assert data["modelReady"] is True
    assert data["model"] == "qwen3-0.6b-generic-cpu:4"
