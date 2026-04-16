"""Shared types and helpers for usage scanners."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Protocol


# Canonical agent ids used everywhere (DB enum, env vars, UI chips).
COPILOT = "copilot"
CLAUDE_CODE = "claude-code"
CODEX = "codex"
OPENCODE = "opencode"

AGENTS = (COPILOT, CLAUDE_CODE, CODEX, OPENCODE)


@dataclass
class SessionRow:
    """One normalized session row, agent-agnostic."""
    agent: str
    native_id: str
    cwd: str | None
    title: str | None
    model: str | None
    provider: str | None
    cli_version: str | None
    git_branch: str | None
    source_path: str
    started_at: str  # ISO 8601 UTC
    updated_at: str  # ISO 8601 UTC


@dataclass
class TurnRow:
    """One normalized turn (assistant response + usage)."""
    agent: str
    native_session_id: str
    seq: int
    occurred_at: str  # ISO 8601 UTC
    model: str | None
    provider: str | None
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    total_tokens: int = 0
    tool_calls: int = 0
    finish_reason: str | None = None


@dataclass
class AgentSource:
    """Persisted cursor for one source file / DB row."""
    agent: str
    source_path: str
    last_offset: int = 0
    last_mtime: int = 0  # ms epoch
    last_native_id: str | None = None
    scanned_at: str | None = None


@dataclass
class ScanResult:
    """What a scanner returns from one scan() call."""
    sessions: list[SessionRow] = field(default_factory=list)
    turns: list[TurnRow] = field(default_factory=list)
    # Updated cursor rows keyed by source_path. Writer persists these
    # ONLY after sessions+turns commit successfully.
    updated_sources: dict[str, AgentSource] = field(default_factory=dict)
    # Detection metadata (last time the agent produced activity).
    last_active_at: str | None = None


@dataclass
class DetectionResult:
    installed: bool
    detected_at: str | None = None  # ISO 8601
    data_path: str | None = None    # cosmetic — for the Settings UI


class AgentScanner(Protocol):
    agent: str

    def detect(self) -> DetectionResult: ...

    def seed(self) -> ScanResult:
        """First-run metadata-only seed: emit SessionRow for every currently
        existing session (no turns) and initialize cursor rows pinned to
        current EOF / max native id / current mtime."""

    def scan(self, sources: dict[str, AgentSource]) -> ScanResult:
        """Incremental scan. ``sources`` maps source_path -> existing cursor.
        Unknown source_paths are new sources and should be scanned from their
        current state as a *seed* (not a full backfill)."""


# ── helpers ──────────────────────────────────────────────────────────────────

def canonical_cwd(path: str | None) -> str | None:
    """Realpath + normcase so that session cwds and process.cwd() match."""
    if not path:
        return None
    try:
        return os.path.normcase(os.path.realpath(path))
    except OSError:
        return os.path.normcase(path)


def iso_utc(epoch_seconds: float | None = None) -> str:
    from datetime import datetime, timezone
    t = time.time() if epoch_seconds is None else epoch_seconds
    return datetime.fromtimestamp(t, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def iso_from_ms(ms_epoch: int) -> str:
    return iso_utc(ms_epoch / 1000.0)
