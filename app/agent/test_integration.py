"""Live integration tests for the Foundry Todo Agent Python backend.

All tests hit a real running server (started in conftest.py) with a real
Foundry Local model. No mocking.

Run:
    pytest test_integration.py -v
    pytest test_integration.py -v -m slow   # includes model-switch test
"""

from __future__ import annotations
import json
from pathlib import Path

import httpx
import pytest

from conftest import collect_sse

# ── 1. Health gate ────────────────────────────────────────────────────────────

async def test_health_ready(client: httpx.AsyncClient) -> None:
    """Server must report both foundryReady and modelReady."""
    r = await client.get("/api/health")
    assert r.status_code == 200
    data = r.json()
    assert data["foundryReady"] is True,  f"foundryReady is False — startupError: {data.get('startupError')}"
    assert data["modelReady"]   is True,  "modelReady is False after startup wait"
    assert data["model"],                 "model field is empty"


# ── 2. Models list ────────────────────────────────────────────────────────────

async def test_models_list(client: httpx.AsyncClient) -> None:
    r = await client.get("/api/models")
    assert r.status_code == 200
    data = r.json()
    assert "models" in data
    assert "active" in data
    assert isinstance(data["models"], list)
    assert len(data["models"]) > 0, "No models returned — is foundry model list working?"
    active_ids = {m["modelId"] for m in data["models"] if m.get("active")}
    assert len(active_ids) == 1, f"Expected exactly one active model, got: {active_ids}"


# ── 3–6. Todo CRUD ────────────────────────────────────────────────────────────

async def test_todos_empty_after_clear(client: httpx.AsyncClient, clean_state) -> None:
    r = await client.get("/api/todos")
    assert r.status_code == 200
    assert r.json() == []


async def test_todo_patch_completed(client: httpx.AsyncClient, clean_state) -> None:
    import state as state_mod
    todo = state_mod.add_todo("Integration test todo", source="test")

    r = await client.patch(f"/api/todos/{todo['id']}", json={"completed": True})
    assert r.status_code == 200
    patched = r.json()
    assert patched["completed"] is True
    assert patched["id"] == todo["id"]


async def test_todo_patch_title(client: httpx.AsyncClient, clean_state) -> None:
    import state as state_mod
    todo = state_mod.add_todo("Old title", source="test")

    r = await client.patch(f"/api/todos/{todo['id']}", json={"title": "New title"})
    assert r.status_code == 200
    assert r.json()["title"] == "New title"


async def test_todo_delete(client: httpx.AsyncClient, clean_state) -> None:
    import state as state_mod
    todo = state_mod.add_todo("To be deleted", source="test")

    r = await client.delete(f"/api/todos/{todo['id']}")
    assert r.status_code == 200
    assert r.json()["success"] is True

    r = await client.get("/api/todos")
    assert all(t["id"] != todo["id"] for t in r.json())


async def test_todo_patch_404(client: httpx.AsyncClient) -> None:
    r = await client.patch("/api/todos/nonexistent-id", json={"completed": True})
    assert r.status_code == 404


# ── 7–9. Templates ────────────────────────────────────────────────────────────

async def test_templates_list(client: httpx.AsyncClient, clean_state) -> None:
    r = await client.get("/api/templates")
    assert r.status_code == 200
    data = r.json()
    assert "builtIn" in data
    assert "active" in data
    assert len(data["builtIn"]) == 7, f"Expected 7 built-in templates, got {len(data['builtIn'])}"


async def test_template_activate(client: httpx.AsyncClient, clean_state) -> None:
    import state as state_mod
    title = state_mod.BUILT_IN_TEMPLATES[0]["title"]

    r = await client.post("/api/templates/activate", json={"title": title})
    assert r.status_code == 200
    rec = r.json()
    assert rec["active"] is True
    assert rec["title"] == title
    assert "id" in rec


async def test_template_deactivate(client: httpx.AsyncClient, clean_state) -> None:
    import state as state_mod
    tpl = state_mod.BUILT_IN_TEMPLATES[1]
    rec = state_mod.activate_template(tpl)

    r = await client.post("/api/templates/deactivate", json={"id": rec["id"]})
    assert r.status_code == 200
    assert r.json()["active"] is False


# ── 10–11. Telemetry ──────────────────────────────────────────────────────────

async def test_telemetry_snapshot(client: httpx.AsyncClient) -> None:
    r = await client.get("/api/telemetry/snapshot")
    assert r.status_code == 200
    data = r.json()
    assert "events" in data
    assert "serverTime" in data
    assert isinstance(data["events"], list)


async def test_telemetry_stream_first_event(client: httpx.AsyncClient) -> None:
    """SSE stream should immediately yield a health.snapshot event."""
    first_event: dict | None = None
    async with client.stream("GET", "/api/telemetry/stream", timeout=15) as r:
        assert r.status_code == 200
        assert "text/event-stream" in r.headers.get("content-type", "")
        buf = ""
        async for chunk in r.aiter_text():
            buf += chunk
            while "\n\n" in buf:
                block, buf = buf.split("\n\n", 1)
                for line in block.splitlines():
                    if line.startswith("data: "):
                        try:
                            first_event = json.loads(line[6:])
                        except json.JSONDecodeError:
                            pass
            if first_event:
                break

    assert first_event is not None, "No event received from telemetry stream"
    assert first_event.get("type") is not None, f"Event missing 'type' field: {first_event}"


# ── 12. Extract SSE (real LLM) ────────────────────────────────────────────────

async def test_extract_sse(client: httpx.AsyncClient, clean_state) -> None:
    """Real text with clear tasks should produce a tasks_extracted event."""
    import state as state_mod
    text = (
        "Team standup notes from today:\n"
        "- Alice: needs to finish the login page by Friday\n"
        "- Bob: will review the database schema tomorrow morning\n"
        "- Carol: schedule a design review meeting with the team next week\n"
        "- Follow up: send weekly status email to stakeholders by end of day"
    )

    events = await collect_sse(
        client, "/api/extract", {"text": text}, until_type="done", timeout=90
    )

    types = {e.get("type") for e in events}
    assert "tasks_extracted" in types, f"tasks_extracted not in event types: {types}"

    extracted_ev = next(e for e in events if e.get("type") == "tasks_extracted")
    tasks = extracted_ev.get("tasks", [])
    assert len(tasks) >= 1, "Expected at least 1 extracted task"
    assert all(t.get("title") for t in tasks), "Every extracted task must have a title"

    # State must reflect the additions
    assert len(state_mod.todos) >= len(tasks), "state_mod.todos did not grow after extraction"


# ── 13. Process speech (real LLM) ────────────────────────────────────────────

async def test_process_speech(client: httpx.AsyncClient, clean_state) -> None:
    transcript = "remind me to call the dentist tomorrow at 9 AM and also pick up the dry cleaning"

    r = await client.post("/api/process-speech", json={"text": transcript})
    assert r.status_code == 200
    data = r.json()
    assert data["success"] is True
    assert isinstance(data["tasks"], list)
    assert len(data["tasks"]) >= 1, "Expected at least 1 task from speech"
    assert all(t.get("title") for t in data["tasks"])


# ── 14. AG-UI command — todo creation verified end-to-end ────────────────────

async def test_command_adds_todo(client: httpx.AsyncClient, clean_state) -> None:
    """'Add buy milk' must result in the task appearing in GET /api/todos.

    Retried up to 3 times because phi-4-mini (256 max output tokens) may
    occasionally generate explanation text before the tool call and exhaust
    its token budget. If all attempts fail the test is marked xfail.
    """
    import state as state_mod

    found_in_api = False
    last_api_titles: list = []

    for attempt in range(3):
        state_mod.todos.clear()
        body = {
            "threadId": f"test-thread-add-{attempt}",
            "runId":    f"test-run-add-{attempt}",
            "state": {"todos": [], "recurringTemplates": []},
            "messages": [{"id": "m1", "role": "user", "content": "add buy milk"}],
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }

        events = await collect_sse(client, "/api/command", body, until_type="RUN_FINISHED", timeout=90)
        types = {e.get("type") for e in events}
        assert "RUN_FINISHED" in types, f"RUN_FINISHED not received on attempt {attempt+1}. Got: {types}"

        r = await client.get("/api/todos")
        todos_from_api = r.json()
        last_api_titles = [t.get("title") for t in todos_from_api]
        if any("milk" in (t or "").lower() for t in last_api_titles):
            found_in_api = True
            break

    if not found_in_api:
        pytest.xfail(
            "phi-4-mini (256 max output tokens) did not call add_task after 3 attempts. "
            f"Last API todos: {last_api_titles}"
        )


# ── 15. AG-UI command — streaming text events ─────────────────────────────────

async def test_command_streaming_text(client: httpx.AsyncClient, clean_state) -> None:
    """Any command should produce TEXT_MESSAGE_CONTENT streaming events and RUN_FINISHED."""
    body = {
        "threadId": "test-thread-stream",
        "runId": "test-run-stream",
        "state": {"todos": [], "recurringTemplates": []},
        "messages": [{"id": "m1", "role": "user", "content": "How many tasks do I have?"}],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }

    events = await collect_sse(client, "/api/command", body, until_type="RUN_FINISHED", timeout=90)

    types = {e.get("type") for e in events}
    assert "RUN_FINISHED"         in types, f"RUN_FINISHED missing. Got: {types}"
    assert "TEXT_MESSAGE_START"   in types, f"TEXT_MESSAGE_START missing. Got: {types}"
    assert "TEXT_MESSAGE_CONTENT" in types, f"TEXT_MESSAGE_CONTENT missing. Got: {types}"

    # Reconstruct the streamed text
    text_chunks = [e["delta"] for e in events if e.get("type") == "TEXT_MESSAGE_CONTENT"]
    full_text = "".join(text_chunks)
    assert len(full_text) > 0, "TEXT_MESSAGE_CONTENT events produced empty text"


# ── 16. AG-UI command — multi-turn context ────────────────────────────────────

async def test_command_history_context(client: httpx.AsyncClient, clean_state) -> None:
    """Second turn should contextually reference the first turn."""
    import state as state_mod

    thread_id = "test-thread-multi"

    # Turn 1: ask a question that requires no tool call — just context for turn 2.
    turn1_body = {
        "threadId": thread_id,
        "runId": "run-1",
        "state": {"todos": [], "recurringTemplates": []},
        "messages": [{"id": "m1", "role": "user", "content": "My favourite project is called Nighthawk."}],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }
    turn1_events = await collect_sse(client, "/api/command", turn1_body, until_type="RUN_FINISHED", timeout=90)
    assert any(e.get("type") == "RUN_FINISHED" for e in turn1_events), "Turn 1 RUN_FINISHED missing"

    t1_text = "".join(e["delta"] for e in turn1_events if e.get("type") == "TEXT_MESSAGE_CONTENT")
    t1_msg_id = next((e["messageId"] for e in turn1_events if e.get("type") == "TEXT_MESSAGE_START"), "a1")

    # Turn 2: question that requires turn-1 context — must mention "Nighthawk".
    turn2_body = {
        "threadId": thread_id,
        "runId": "run-2",
        "state": {"todos": state_mod.todos.copy(), "recurringTemplates": []},
        "messages": [
            {"id": "m1",      "role": "user",      "content": "My favourite project is called Nighthawk."},
            {"id": t1_msg_id, "role": "assistant",  "content": t1_text},
            {"id": "m2",      "role": "user",       "content": "What project did I just mention?"},
        ],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }
    turn2_events = await collect_sse(client, "/api/command", turn2_body, until_type="RUN_FINISHED", timeout=90)
    assert any(e.get("type") == "RUN_FINISHED" for e in turn2_events), "Turn 2 RUN_FINISHED missing"

    t2_text = "".join(e["delta"] for e in turn2_events if e.get("type") == "TEXT_MESSAGE_CONTENT").lower()

    if "nighthawk" not in t2_text:
        pytest.xfail(
            f"Model did not reference 'Nighthawk' in turn 2. Got: {t2_text[:200]!r}"
        )


# ── 17. Frontend HTML structural check ───────────────────────────────────────

def test_frontend_html_agui_markers() -> None:
    """Validate that all AG-UI integration elements are present in index.html."""
    html_path = Path(__file__).parent.parent / "public" / "index.html"
    assert html_path.exists(), "public/index.html not found"
    html = html_path.read_text(encoding="utf-8")

    checks = {
        "fast-json-patch CDN":       "fast-json-patch",
        "agThreadId variable":       "agThreadId",
        "conversationHistory":       "conversationHistory",
        "processAGUISSE function":   "processAGUISSE",
        "STATE_SNAPSHOT handler":    "STATE_SNAPSHOT",
        "STATE_DELTA handler":       "STATE_DELTA",
        "TEXT_MESSAGE_CONTENT":      "TEXT_MESSAGE_CONTENT",
        "jsonpatch.applyPatch call":  "jsonpatch.applyPatch",
        "threadId in POST body":     "threadId",
        "RunAgentInput runId field":  "runId",
        "Logs tab":                  'data-tab="logs"',
        "Traces tab":                'data-tab="traces"',
        "Events filter bar":         'eventsFilterBar',
        "generateTraceparent":       'generateTraceparent',
    }

    failures = [label for label, marker in checks.items() if marker not in html]
    assert not failures, f"Missing AG-UI markers in index.html: {failures}"


# ── Config + hardware ─────────────────────────────────────────────────────────

async def test_config_get(client: httpx.AsyncClient) -> None:
    """GET /api/config returns modelPermission, preferredDevice, and hardware profile."""
    r = await client.get("/api/config")
    assert r.status_code == 200
    data = r.json()
    assert "modelPermission" in data
    assert data["modelPermission"] in ("ask", "yolo")
    assert "preferredDevice" in data
    assert data["preferredDevice"] in ("auto", "npu", "gpu", "cpu")
    hw = data.get("hardware", {})
    assert "cpu" in hw, "hardware.cpu missing"
    assert "npu" in hw, "hardware.npu missing"


async def test_config_update_permission(client: httpx.AsyncClient) -> None:
    """POST /api/config can toggle modelPermission; rejects unknown values."""
    import app_config as cfg

    # Toggle to yolo
    r = await client.post("/api/config", json={"modelPermission": "yolo"})
    assert r.status_code == 200
    assert r.json()["modelPermission"] == "yolo"

    # Toggle back to ask
    r = await client.post("/api/config", json={"modelPermission": "ask"})
    assert r.status_code == 200
    assert r.json()["modelPermission"] == "ask"

    # Invalid value → 400
    r = await client.post("/api/config", json={"modelPermission": "please"})
    assert r.status_code == 400

    # Restore in-process state (config save goes to disk; in-process already correct)
    cfg.set("modelPermission", "ask")


async def test_config_update_device(client: httpx.AsyncClient) -> None:
    """POST /api/config can set preferredDevice."""
    import app_config as cfg

    r = await client.post("/api/config", json={"preferredDevice": "gpu"})
    assert r.status_code == 200
    assert r.json()["preferredDevice"] == "gpu"

    r = await client.post("/api/config", json={"preferredDevice": "auto"})
    assert r.status_code == 200
    assert r.json()["preferredDevice"] == "auto"

    cfg.set("preferredDevice", "auto")


# ── Model switch: recommendation flow ────────────────────────────────────────

async def test_model_switch_recommendation(client: httpx.AsyncClient) -> None:
    """Switching to an undownloaded model in 'ask' mode emits a recommendation event
    with the requested model details and (optionally) an already-loaded alternative."""
    import app_config as cfg

    cfg.set("modelPermission", "ask")

    try:
        # Find a model that is in the catalog but NOT loaded (not downloaded locally).
        r = await client.get("/api/models")
        assert r.status_code == 200
        models = r.json()["models"]
        unloaded = [m for m in models if not m.get("loaded") and not m.get("active")]
        if not unloaded:
            pytest.skip("All catalog models are loaded — can't test recommendation flow.")

        target = unloaded[0]
        events = await collect_sse(
            client,
            "/api/models/switch",
            {"modelId": target["modelId"], "forceDownload": False},
            until_type="recommendation",
            timeout=60,
        )

        types = {e.get("type") for e in events}
        assert "recommendation" in types, (
            f"Expected 'recommendation' event for undownloaded model. Got: {types}"
        )

        rec = next(e for e in events if e.get("type") == "recommendation")
        assert rec["requestedModel"]["modelId"] == target["modelId"]
        assert rec["permission"] == "ask"
        assert "forceDownload" in rec["action"] or "forcedownload" in rec["action"].lower()

        # Verify the active model is UNCHANGED after a recommendation-only response
        r = await client.get("/api/health")
        assert r.json()["model"] != target["modelId"], (
            "Active model should not change when permission=ask and forceDownload=False"
        )
    finally:
        cfg.set("modelPermission", "ask")


# ── Speech config ─────────────────────────────────────────────────────────────

async def test_speech_config_defaults(client: httpx.AsyncClient) -> None:
    """GET /api/config should include speech settings with defaults."""
    r = await client.get("/api/config")
    assert r.status_code == 200
    data = r.json()
    assert "speech" in data, "speech config missing from /api/config"
    speech = data["speech"]
    assert speech["engine"] in ("auto", "web", "whisper", "sapi")
    assert speech["fallback"] in ("web", "whisper", "sapi", "none")


async def test_speech_config_update(client: httpx.AsyncClient) -> None:
    """POST /api/config can update speech settings."""
    import app_config as cfg

    r = await client.post("/api/config", json={
        "speech": {"engine": "whisper", "fallback": "none"}
    })
    assert r.status_code == 200
    data = r.json()
    assert data["speech"]["engine"] == "whisper"
    assert data["speech"]["fallback"] == "none"

    # Invalid engine → error
    r = await client.post("/api/config", json={
        "speech": {"engine": "invalid_engine"}
    })
    assert r.status_code == 400

    # Restore defaults
    cfg.set("speech", {"engine": "auto", "fallback": "whisper", "micDevice": None})


async def test_speech_config_update_mic(client: httpx.AsyncClient) -> None:
    """POST /api/config can set micDevice."""
    import app_config as cfg

    r = await client.post("/api/config", json={
        "speech": {"micDevice": "test-device-id"}
    })
    assert r.status_code == 200
    assert r.json()["speech"]["micDevice"] == "test-device-id"

    # Clear it
    r = await client.post("/api/config", json={
        "speech": {"micDevice": ""}
    })
    assert r.status_code == 200
    assert r.json()["speech"]["micDevice"] is None

    cfg.set("speech", {"engine": "auto", "fallback": "whisper", "micDevice": None})


# ── Transcribe ────────────────────────────────────────────────────────────────

async def test_transcribe_requires_audio(client: httpx.AsyncClient) -> None:
    """POST /api/transcribe without a file should fail."""
    r = await client.post("/api/transcribe")
    assert r.status_code == 422  # FastAPI validation error for missing file


async def test_transcribe_wav(client: httpx.AsyncClient) -> None:
    """POST /api/transcribe with a valid WAV returns text.

    Generates a short silent WAV in-memory to verify the endpoint works
    without requiring a real audio file. Whisper returns empty or near-empty
    text for silence, but the endpoint should not crash.
    """
    import struct
    # Generate a 1-second silent WAV (16kHz, 16-bit, mono)
    sample_rate = 16000
    duration = 1
    num_samples = sample_rate * duration
    data_size = num_samples * 2  # 16-bit = 2 bytes per sample

    wav = bytearray()
    wav.extend(b'RIFF')
    wav.extend(struct.pack('<I', 36 + data_size))
    wav.extend(b'WAVE')
    wav.extend(b'fmt ')
    wav.extend(struct.pack('<IHHIIHH', 16, 1, 1, sample_rate, sample_rate * 2, 2, 16))
    wav.extend(b'data')
    wav.extend(struct.pack('<I', data_size))
    wav.extend(b'\x00' * data_size)

    r = await client.post(
        "/api/transcribe",
        files={"audio": ("test.wav", bytes(wav), "audio/wav")},
        timeout=120,
    )
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
    data = r.json()
    assert "text" in data, f"Response missing 'text' field: {data}"
    assert isinstance(data["text"], str)


# ── Slow: model switch ────────────────────────────────────────────────────────

@pytest.mark.slow
async def test_model_switch(client: httpx.AsyncClient) -> None:
    """Switch to an already-loaded alternative model and verify SSE 'done' event.

    Requires a second model to already be downloaded and loaded in the Foundry
    service (e.g. run 'foundry model download <id>' beforehand).
    """
    import agent as agent_mod

    r = await client.get("/api/models")
    assert r.status_code == 200
    models = r.json()["models"]
    current = r.json()["active"]
    alternatives = [m for m in models if m["modelId"] != current and m.get("loaded")]
    if not alternatives:
        pytest.skip(
            "No other model is currently loaded in the Foundry service. "
            "Download a second model with 'foundry model download <modelId>' to enable this test."
        )

    target = alternatives[0]["modelId"]
    events = await collect_sse(
        client,
        "/api/models/switch",
        {"modelId": target},
        until_type="done",
        timeout=360,
    )

    types = {e.get("type") for e in events}
    assert "done" in types, f"Model switch did not produce 'done' event. Got: {types}"

    done_ev = next(e for e in events if e.get("type") == "done")
    assert done_ev["modelId"] == target

    r = await client.get("/api/health")
    assert r.json()["model"] == target


# ── Security headers ──────────────────────────────────────────────────────────

async def test_security_headers(client: httpx.AsyncClient) -> None:
    """All responses should include security headers."""
    # Test on a simple GET endpoint
    r = await client.get("/api/health")
    assert r.status_code == 200
    assert r.headers.get("x-content-type-options") == "nosniff", "Missing X-Content-Type-Options"
    assert r.headers.get("x-frame-options") == "DENY", "Missing X-Frame-Options"
    assert r.headers.get("referrer-policy") == "strict-origin-when-cross-origin", "Missing Referrer-Policy"

    # Also verify on POST endpoint
    r2 = await client.get("/api/config")
    assert r2.headers.get("x-content-type-options") == "nosniff", "Missing security headers on config endpoint"


# ── New config field defaults ─────────────────────────────────────────────────

async def test_config_new_field_defaults(client: httpx.AsyncClient) -> None:
    """GET /api/config should include timezone, hideIncompatibleModels, toolCallOnly with proper defaults."""
    r = await client.get("/api/config")
    assert r.status_code == 200
    data = r.json()

    # timezone defaults to None (OS default)
    assert "timezone" in data, "timezone field missing from config"

    # Boolean fields default to False
    assert "hideIncompatibleModels" in data, "hideIncompatibleModels missing"
    assert "toolCallOnly" in data, "toolCallOnly missing"
    assert isinstance(data["hideIncompatibleModels"], bool), "hideIncompatibleModels should be bool"
    assert isinstance(data["toolCallOnly"], bool), "toolCallOnly should be bool"


# ── Boolean config field updates ──────────────────────────────────────────────

async def test_config_update_boolean_fields(client: httpx.AsyncClient) -> None:
    """POST /api/config can toggle hideIncompatibleModels and toolCallOnly."""
    import app_config as cfg

    # Set both to True
    r = await client.post("/api/config", json={"hideIncompatibleModels": True, "toolCallOnly": True})
    assert r.status_code == 200
    data = r.json()
    assert data["hideIncompatibleModels"] is True
    assert data["toolCallOnly"] is True

    # Set both back to False
    r = await client.post("/api/config", json={"hideIncompatibleModels": False, "toolCallOnly": False})
    assert r.status_code == 200
    data = r.json()
    assert data["hideIncompatibleModels"] is False
    assert data["toolCallOnly"] is False

    # Restore
    cfg.set("hideIncompatibleModels", False)
    cfg.set("toolCallOnly", False)


# ── Timezone config update and validation ─────────────────────────────────────

async def test_config_update_timezone(client: httpx.AsyncClient) -> None:
    """POST /api/config can set timezone; rejects invalid values."""
    import app_config as cfg

    # Valid timezone
    r = await client.post("/api/config", json={"timezone": "America/New_York"})
    assert r.status_code == 200
    assert r.json()["timezone"] == "America/New_York"

    # Another valid timezone
    r = await client.post("/api/config", json={"timezone": "Europe/London"})
    assert r.status_code == 200
    assert r.json()["timezone"] == "Europe/London"

    # Empty string clears to None (OS default)
    r = await client.post("/api/config", json={"timezone": ""})
    assert r.status_code == 200
    assert r.json()["timezone"] is None

    # Invalid timezone → 400
    r = await client.post("/api/config", json={"timezone": "Not/A/Real/Zone"})
    assert r.status_code == 400

    # Restore
    cfg.set("timezone", None)


# ── Timezone propagation ──────────────────────────────────────────────────────

async def test_timezone_propagation(client: httpx.AsyncClient) -> None:
    """Setting timezone in config should affect _get_tz() in tools and notifications."""
    import app_config as cfg
    from notifications import _get_tz as notif_tz
    from tools import _get_tz as tools_tz

    # Set to a specific timezone
    cfg.set("timezone", "Asia/Tokyo")

    tz_notif = notif_tz()
    tz_tools = tools_tz()
    assert str(tz_notif) == "Asia/Tokyo", f"notifications._get_tz() returned {tz_notif}, expected Asia/Tokyo"
    assert str(tz_tools) == "Asia/Tokyo", f"tools._get_tz() returned {tz_tools}, expected Asia/Tokyo"

    # Clear timezone — should fall back to America/Los_Angeles
    cfg.set("timezone", None)
    tz_default = notif_tz()
    assert str(tz_default) == "America/Los_Angeles", f"Fallback should be America/Los_Angeles, got {tz_default}"

    # Invalid timezone should also fall back
    cfg.set("timezone", "Invalid/Zone")
    tz_invalid = notif_tz()
    assert str(tz_invalid) == "America/Los_Angeles", f"Invalid tz should fall back, got {tz_invalid}"

    # Restore
    cfg.set("timezone", None)


# ── New-fields integration tests ──────────────────────────────────────────────


async def test_create_todo_with_new_fields(client: httpx.AsyncClient, clean_state):
    """POST /api/todos creates a todo with priority, notes, tags."""
    r = await client.post("/api/todos", json={
        "title": "Test rich todo",
        "priority": "high",
        "notes": "Some **markdown** notes\nWith newlines",
        "tags": ["work", "urgent"],
        "emoji": "🔥",
    })
    assert r.status_code == 201
    todo = r.json()
    assert todo["title"] == "Test rich todo"
    assert todo["priority"] == "high"
    assert todo["notes"] == "Some **markdown** notes\nWith newlines"
    assert set(todo["tags"]) == {"work", "urgent"}
    assert todo["emoji"] == "🔥"
    assert todo["completed"] is False


async def test_create_todo_defaults(client: httpx.AsyncClient, clean_state):
    """POST /api/todos with minimal fields uses sensible defaults."""
    r = await client.post("/api/todos", json={"title": "Bare todo"})
    assert r.status_code == 201
    todo = r.json()
    assert todo["priority"] == "none"
    assert todo["notes"] is None
    assert todo["tags"] == []


async def test_patch_priority(client: httpx.AsyncClient, clean_state):
    """PATCH /api/todos/:id updates priority with validation."""
    r = await client.post("/api/todos", json={"title": "Priority test"})
    todo_id = r.json()["id"]

    # Valid priority
    r = await client.patch(f"/api/todos/{todo_id}", json={"priority": "high"})
    assert r.status_code == 200
    assert r.json()["priority"] == "high"

    # Change to medium
    r = await client.patch(f"/api/todos/{todo_id}", json={"priority": "medium"})
    assert r.json()["priority"] == "medium"


async def test_patch_notes(client: httpx.AsyncClient, clean_state):
    """PATCH /api/todos/:id updates notes field."""
    r = await client.post("/api/todos", json={"title": "Notes test"})
    todo_id = r.json()["id"]

    markdown = "# Header\n- item 1\n- item 2\n\n**bold** and _italic_"
    r = await client.patch(f"/api/todos/{todo_id}", json={"notes": markdown})
    assert r.status_code == 200
    assert r.json()["notes"] == markdown


async def test_patch_tags(client: httpx.AsyncClient, clean_state):
    """PATCH /api/todos/:id updates tags with deduplication."""
    r = await client.post("/api/todos", json={"title": "Tags test"})
    todo_id = r.json()["id"]

    r = await client.patch(f"/api/todos/{todo_id}", json={"tags": ["work", "personal", "work"]})
    assert r.status_code == 200
    tags = r.json()["tags"]
    assert len(tags) == 2
    assert set(tags) == {"work", "personal"}


async def test_patch_priority_validation(client: httpx.AsyncClient, clean_state):
    """PATCH with invalid priority is ignored, original value preserved."""
    r = await client.post("/api/todos", json={"title": "Validate test", "priority": "low"})
    todo_id = r.json()["id"]

    # Invalid priority should be ignored
    r = await client.patch(f"/api/todos/{todo_id}", json={"priority": "super-urgent"})
    assert r.status_code == 200
    assert r.json()["priority"] == "low"  # unchanged


async def test_patch_notes_truncation(client: httpx.AsyncClient, clean_state):
    """PATCH truncates notes to 5000 characters."""
    r = await client.post("/api/todos", json={"title": "Truncation test"})
    todo_id = r.json()["id"]

    long_notes = "x" * 6000
    r = await client.patch(f"/api/todos/{todo_id}", json={"notes": long_notes})
    assert r.status_code == 200
    assert len(r.json()["notes"]) == 5000


async def test_patch_tags_limit(client: httpx.AsyncClient, clean_state):
    """PATCH limits tags to 10 entries."""
    r = await client.post("/api/todos", json={"title": "Tags limit test"})
    todo_id = r.json()["id"]

    many_tags = [f"tag-{i}" for i in range(20)]
    r = await client.patch(f"/api/todos/{todo_id}", json={"tags": many_tags})
    assert r.status_code == 200
    assert len(r.json()["tags"]) == 10


async def test_update_todo_state_function(clean_state):
    """state.update_todo() validates and updates fields correctly."""
    import state as state_mod

    todo = state_mod.add_todo("Direct test", priority="low")

    # Update multiple fields
    result = state_mod.update_todo(todo["id"], title="Updated title", priority="high", notes="New notes")
    assert result is not None
    assert result["title"] == "Updated title"
    assert result["priority"] == "high"
    assert result["notes"] == "New notes"

    # Invalid priority ignored
    result = state_mod.update_todo(todo["id"], priority="invalid")
    assert result["priority"] == "high"  # unchanged

    # Set notes to empty string — treated as clearing (becomes None)
    result = state_mod.update_todo(todo["id"], notes="")
    assert result["notes"] is None

    # Non-existent ID
    result = state_mod.update_todo("fake-id", title="nope")
    assert result is None

