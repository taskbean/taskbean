"""Tests for GET /api/version.

Exercises the version endpoint contract added to the Python backend:
required keys, format, and restart-detection semantics via `started_at`.
"""
from __future__ import annotations
import re
from datetime import datetime

import httpx
import pytest


async def test_version_returns_required_keys(client: httpx.AsyncClient) -> None:
    r = await client.get("/api/version")
    assert r.status_code == 200
    data = r.json()
    for key in ("app", "cli", "git_sha", "started_at"):
        assert key in data, f"missing key: {key}"


async def test_version_app_is_semver(client: httpx.AsyncClient) -> None:
    r = await client.get("/api/version")
    data = r.json()
    assert isinstance(data["app"], str)
    assert len(data["app"]) > 0
    # Major.minor.patch with optional pre-release/build suffix.
    assert re.match(r"^\d+\.\d+\.\d+", data["app"]), f"app not semver: {data['app']!r}"


async def test_version_started_at_parses(client: httpx.AsyncClient) -> None:
    r = await client.get("/api/version")
    data = r.json()
    started_at = data["started_at"]
    assert isinstance(started_at, str)
    # Python 3.11+ parses 'Z' natively via fromisoformat; normalise just in case.
    normalised = started_at.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalised)
    assert parsed is not None


async def test_version_cli_and_git_sha_are_string_or_none(client: httpx.AsyncClient) -> None:
    r = await client.get("/api/version")
    data = r.json()
    assert data["cli"] is None or isinstance(data["cli"], str)
    assert data["git_sha"] is None or isinstance(data["git_sha"], str)


async def test_version_started_at_stable_across_calls(client: httpx.AsyncClient) -> None:
    """started_at is a module-level constant — two calls in the same run must match.

    This validates that _STARTED_AT isn't re-computed per request.
    """
    r1 = await client.get("/api/version")
    r2 = await client.get("/api/version")
    assert r1.json()["started_at"] == r2.json()["started_at"]


async def test_version_cli_is_cached(client: httpx.AsyncClient) -> None:
    """After the first /api/version call, the CLI version lookup should be cached.

    Validates fix 3: the resolver uses a module-level _UNSET sentinel and does
    not re-spawn `bean --version` on every request.
    """
    import main as main_mod
    assert hasattr(main_mod, "_CLI_VERSION_CACHE"), "fix 3 missing: no _CLI_VERSION_CACHE"
    assert hasattr(main_mod, "_UNSET"), "fix 3 missing: no _UNSET sentinel"
    # Reset to the sentinel and force re-resolution.
    main_mod._CLI_VERSION_CACHE = main_mod._UNSET
    r = await client.get("/api/version")
    assert r.status_code == 200
    # After the call the sentinel should have flipped to a concrete value
    # (string or None — depends on whether `bean` is on PATH in the test env).
    assert main_mod._CLI_VERSION_CACHE is not main_mod._UNSET
