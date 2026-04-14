"""pytest configuration — session-scoped live server + shared fixtures.

The server runs via uvicorn.Server in a background thread so it owns its
own event loop and stays alive regardless of pytest-asyncio's loop
management. Tests share the same state_mod memory (same process).
All HTTP calls use a real httpx.AsyncClient against a real TCP port.
"""

from __future__ import annotations
import asyncio
import json
import logging
import threading
from pathlib import Path
from typing import AsyncGenerator

import httpx
import pytest
import pytest_asyncio
import uvicorn

# ── Port ──────────────────────────────────────────────────────────────────────

TEST_PORT = 3001
BASE_URL  = f"http://127.0.0.1:{TEST_PORT}"

# Maximum seconds to wait for Foundry + model to become ready.
MODEL_READY_TIMEOUT = 360   # 6 minutes — NPU load can be slow

# ── Server fixture ────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def live_server() -> str:
    """Start the real FastAPI app in a background thread and wait until modelReady.

    Running in a thread (not as an asyncio Task) gives uvicorn its own event
    loop so it stays alive while pytest-asyncio drives test loops independently.
    """
    import main  # noqa: F401 — side effects needed

    config = uvicorn.Config(
        "main:app",
        host="127.0.0.1",
        port=TEST_PORT,
        log_level="warning",
    )
    server = uvicorn.Server(config)

    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    # Poll /api/health until modelReady (or timeout)
    import time
    deadline = time.monotonic() + MODEL_READY_TIMEOUT
    logging.getLogger(__name__).info(
        "Waiting up to %ds for Foundry model to be ready…", MODEL_READY_TIMEOUT
    )
    while time.monotonic() < deadline:
        try:
            r = httpx.get(f"{BASE_URL}/api/health", timeout=5)
            data = r.json()
            if data.get("modelReady"):
                break
            if data.get("startupError"):
                pytest.fail(f"Foundry startup error: {data['startupError']}")
        except Exception:
            pass
        time.sleep(3)
    else:
        pytest.fail(
            f"Model not ready after {MODEL_READY_TIMEOUT}s. "
            "Ensure Foundry Local service is running: `foundry service start`"
        )

    yield BASE_URL

    server.should_exit = True
    thread.join(timeout=10)


# ── HTTP client fixture ───────────────────────────────────────────────────────

@pytest_asyncio.fixture(scope="session")
async def client(live_server: str) -> AsyncGenerator[httpx.AsyncClient, None]:
    """Long-lived httpx client for the test session."""
    async with httpx.AsyncClient(base_url=live_server, timeout=120) as c:
        yield c


# ── State cleanup fixture ─────────────────────────────────────────────────────

@pytest.fixture(autouse=False)
def clean_state():
    """Clear in-memory todos and recurring_templates before each test that uses it."""
    import state as state_mod
    state_mod.todos.clear()
    state_mod.recurring_templates.clear()
    yield
    state_mod.todos.clear()
    state_mod.recurring_templates.clear()


# ── SSE helper ────────────────────────────────────────────────────────────────

async def collect_sse(
    client: httpx.AsyncClient,
    path: str,
    body: dict,
    until_type: str,
    timeout: float = 90,
    extra_headers: dict | None = None,
) -> list[dict]:
    """POST to an SSE endpoint and collect events until `until_type` arrives or timeout."""
    events: list[dict] = []
    buf = ""
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if extra_headers:
        headers.update(extra_headers)
    async with client.stream(
        "POST", path,
        json=body,
        headers=headers,
        timeout=timeout,
    ) as response:
        response.raise_for_status()
        async for chunk in response.aiter_text():
            buf += chunk
            while "\n\n" in buf:
                block, buf = buf.split("\n\n", 1)
                for line in block.splitlines():
                    if line.startswith("data: "):
                        try:
                            ev = json.loads(line[6:])
                            events.append(ev)
                            if ev.get("type") == until_type:
                                return events
                        except json.JSONDecodeError:
                            pass
    return events
