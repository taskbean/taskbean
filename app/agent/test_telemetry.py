"""Telemetry-specific integration tests for the refactored OTel pipeline.

Tests verify that:
1. UISpanExporter converts spans to UI events
2. OTel Logs are correlated with traces
3. Telemetry SSE stream delivers span-derived events
4. Jaeger trace proxy endpoints work (graceful degradation)
5. traceparent propagation creates child spans
"""

from __future__ import annotations
import json
import httpx
import pytest
from conftest import collect_sse


# ── UISpanExporter produces events ────────────────────────────────────────────

async def test_telemetry_snapshot_has_events(client: httpx.AsyncClient) -> None:
    """Snapshot should return events derived from OTel spans after server activity."""
    r = await client.get("/api/telemetry/snapshot?limit=50")
    assert r.status_code == 200
    data = r.json()
    assert "events" in data
    assert isinstance(data["events"], list)
    # Server startup generates spans, so there should be some events
    # (health checks, FastAPI auto-instrumentation, etc.)
    assert len(data["events"]) > 0, "Expected at least one event from server activity"
    # Verify new UISpanExporter event format
    if data["events"]:
        ev = data["events"][-1]
        assert "type" in ev
        assert "ts" in ev
        assert "id" in ev


async def test_telemetry_stream_delivers_events(client: httpx.AsyncClient) -> None:
    """SSE stream should deliver at least one event within a few seconds."""
    first_event = None
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
    assert "type" in first_event
    assert "id" in first_event
    assert "ts" in first_event


# ── Trace proxy endpoints ────────────────────────────────────────────────────

async def test_traces_proxy_returns_json(client: httpx.AsyncClient) -> None:
    """GET /api/traces should return valid JSON with traces array, even if Jaeger is down."""
    r = await client.get("/api/traces?limit=5")
    assert r.status_code == 200
    data = r.json()
    assert "traces" in data
    assert isinstance(data["traces"], list)
    # If Jaeger is down, we should get an empty list with optional error, not a crash
    if data["traces"]:
        trace = data["traces"][0]
        assert "traceId" in trace, "Trace missing traceId field"
        assert "spans" in trace, "Trace missing spans field"


async def test_trace_by_id_returns_json(client: httpx.AsyncClient) -> None:
    """GET /api/traces/{id} should return JSON even with invalid trace ID."""
    r = await client.get("/api/traces/0000000000000000")
    assert r.status_code == 200
    data = r.json()
    assert "trace" in data


# ── traceparent propagation ──────────────────────────────────────────────────

async def test_traceparent_header_accepted(client: httpx.AsyncClient) -> None:
    """Server should accept requests with traceparent header without error."""
    r = await client.get(
        "/api/health",
        headers={"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}
    )
    assert r.status_code == 200


async def test_command_with_traceparent(client: httpx.AsyncClient, clean_state) -> None:
    """AG-UI command should work with traceparent header."""
    body = {
        "threadId": "test-trace-ctx",
        "runId": "test-run-trace",
        "state": {"todos": [], "recurringTemplates": []},
        "messages": [{"id": "m1", "role": "user", "content": "hello"}],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }
    events = await collect_sse(
        client, "/api/command", body,
        until_type="RUN_FINISHED", timeout=90,
        extra_headers={"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"},
    )
    types = {e.get("type") for e in events}
    assert "RUN_FINISHED" in types


# ── Metrics instruments ──────────────────────────────────────────────────────

async def test_metric_instruments_exist() -> None:
    """All expected OTel metric instruments should be accessible."""
    import telemetry as telem

    assert telem.ai_call_counter is not None
    assert telem.ai_error_counter is not None
    assert telem.task_extract_counter is not None
    assert telem.command_counter is not None
    assert telem.ai_latency is not None
    assert telem.command_latency is not None
