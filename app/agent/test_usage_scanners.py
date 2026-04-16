"""Integration tests for the four multi-agent usage scanners.

Runs with:
    cd app/agent && pytest test_usage_scanners.py -v

No live uvicorn server — these are pure unit/integration tests that exercise
the scanner modules and the DB writer directly. Each test monkeypatches the
scanner's home-dir constants to point at a tmp_path-built fixture.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from pathlib import Path

import pytest

from usage import db as usage_db
from usage.jsonl_reader import read_jsonl_incremental
from usage.scanners import (
    ClaudeCodeScanner,
    CodexScanner,
    CopilotScanner,
    OpenCodeScanner,
)
from usage.scanners import claude_code as cc_mod
from usage.scanners import codex as cx_mod
from usage.scanners import copilot as cp_mod
from usage.scanners import opencode as oc_mod


# ─── fixture builders ────────────────────────────────────────────────────────

COPILOT_SESSION_ID = "11111111-1111-1111-1111-111111111111"
CLAUDE_SESSION_ID  = "22222222-2222-2222-2222-222222222222"
CODEX_SESSION_ID   = "33333333-3333-3333-3333-333333333333"
OPENCODE_SESSION_ID = "ses_opencode_abcdef"


def _write_jsonl(path: Path, events: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for ev in events:
            f.write(json.dumps(ev) + "\n")


def build_copilot_fixture(root: Path) -> dict:
    """Create ~/.copilot layout under root. Returns paths dict."""
    home = root / ".copilot"
    state = home / "session-state"
    db_path = home / "session-store.db"
    home.mkdir(parents=True, exist_ok=True)

    # SQLite sessions table.
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            cwd TEXT,
            summary TEXT,
            created_at TEXT,
            updated_at TEXT
        )
    """)
    conn.execute(
        "INSERT INTO sessions VALUES (?, ?, ?, ?, ?)",
        (COPILOT_SESSION_ID, str(root / "proj"), "Fix a bug",
         "2026-04-01T00:00:00Z", "2026-04-01T00:05:00Z"),
    )
    conn.commit()
    conn.close()

    # events.jsonl — 2 assistant messages, 1 tool call between them.
    ev_path = state / COPILOT_SESSION_ID / "events.jsonl"
    _write_jsonl(ev_path, [
        {"type": "session.start",
         "timestamp": "2026-04-01T00:00:00Z",
         "data": {"selectedModel": "gpt-5"}},
        {"type": "user.message",
         "timestamp": "2026-04-01T00:00:10Z",
         "data": {"text": "hi"}},
        {"type": "tool.execution_start",
         "timestamp": "2026-04-01T00:00:15Z",
         "data": {"toolName": "read_file"}},
        {"type": "assistant.message",
         "timestamp": "2026-04-01T00:00:20Z",
         "data": {"outputTokens": 42, "finishReason": "stop"}},
        {"type": "user.message",
         "timestamp": "2026-04-01T00:01:00Z",
         "data": {"text": "and"}},
        {"type": "assistant.message",
         "timestamp": "2026-04-01T00:01:05Z",
         "data": {"outputTokens": 17, "finishReason": "stop"}},
        {"type": "session.task_complete",
         "timestamp": "2026-04-01T00:01:10Z",
         "data": {"summary": "Fixed the bug"}},
    ])
    return {"home": home, "db": db_path, "state": state, "events": ev_path}


def build_claude_fixture(root: Path) -> dict:
    home = root / ".claude"
    projects = home / "projects"
    encoded = projects / "C--Users-test"
    path = encoded / f"{CLAUDE_SESSION_ID}.jsonl"
    _write_jsonl(path, [
        {"type": "user",
         "sessionId": CLAUDE_SESSION_ID,
         "timestamp": "2026-04-01T00:00:00Z",
         "cwd": str(root / "proj"),
         "version": "1.2.3",
         "gitBranch": "main",
         "message": {"role": "user", "content": "do it"}},
        {"type": "assistant",
         "sessionId": CLAUDE_SESSION_ID,
         "timestamp": "2026-04-01T00:00:05Z",
         "cwd": str(root / "proj"),
         "version": "1.2.3",
         "gitBranch": "main",
         "message": {
             "model": "claude-sonnet-4-20250514",
             "usage": {
                 "input_tokens": 100,
                 "cache_read_input_tokens": 50,
                 "cache_creation_input_tokens": 10,
                 "output_tokens": 200,
             },
             "stop_reason": "tool_use",
             "content": [
                 {"type": "text", "text": "ok"},
                 {"type": "tool_use", "name": "Read"},
             ],
         }},
        {"type": "user",
         "sessionId": CLAUDE_SESSION_ID,
         "timestamp": "2026-04-01T00:00:30Z",
         "cwd": str(root / "proj"),
         "message": {"role": "user", "content": "continue"}},
        {"type": "assistant",
         "sessionId": CLAUDE_SESSION_ID,
         "timestamp": "2026-04-01T00:00:35Z",
         "cwd": str(root / "proj"),
         "message": {
             "model": "claude-sonnet-4-20250514",
             "usage": {
                 "input_tokens": 120,
                 "cache_read_input_tokens": 80,
                 "output_tokens": 300,
             },
             "stop_reason": "end_turn",
             "content": [{"type": "text", "text": "done"}],
         }},
    ])
    return {"home": home, "projects": projects, "path": path}


def build_codex_fixture(root: Path) -> dict:
    home = root / ".codex"
    sessions_dir = home / "sessions" / "2026" / "04" / "01"
    path = sessions_dir / f"rollout-2026-04-01T00-00-00-{CODEX_SESSION_ID}.jsonl"
    _write_jsonl(path, [
        {"type": "session_meta",
         "timestamp": "2026-04-01T00:00:00Z",
         "payload": {
             "id": CODEX_SESSION_ID,
             "cwd": str(root / "proj"),
             "cli_version": "0.42.0",
             "model": "gpt-5-codex",
             "model_provider": "openai",
         }},
        {"type": "event_msg",
         "timestamp": "2026-04-01T00:00:02Z",
         "payload": {"type": "task_started"}},
        {"type": "event_msg",
         "timestamp": "2026-04-01T00:00:03Z",
         "payload": {"type": "tool_call", "info": {"name": "read"}}},
        {"type": "event_msg",
         "timestamp": "2026-04-01T00:00:10Z",
         "payload": {
             "type": "token_count",
             "info": {
                 "last_token_usage": {
                     "input_tokens": 400,
                     "cached_input_tokens": 100,
                     "output_tokens": 60,
                     "reasoning_output_tokens": 25,
                     "total_tokens": 585,
                 },
                 "total_token_usage": {"total_tokens": 585},
             },
         }},
        {"type": "event_msg",
         "timestamp": "2026-04-01T00:00:20Z",
         "payload": {"type": "task_started"}},
        {"type": "event_msg",
         "timestamp": "2026-04-01T00:00:25Z",
         "payload": {
             "type": "token_count",
             "info": {
                 "last_token_usage": {
                     "input_tokens": 120,
                     "cached_input_tokens": 0,
                     "output_tokens": 40,
                     "reasoning_output_tokens": 10,
                     "total_tokens": 170,
                 },
             },
         }},
    ])
    return {"home": home, "sessions_dir": home / "sessions", "path": path}


def build_opencode_fixture(root: Path) -> dict:
    home = root / ".local" / "share" / "opencode"
    home.mkdir(parents=True, exist_ok=True)
    db_path = home / "opencode.db"
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            directory TEXT,
            title TEXT,
            version TEXT,
            time_created INTEGER,
            time_updated INTEGER
        );
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT,
            time_created INTEGER,
            time_updated INTEGER,
            data TEXT
        );
        CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT,
            data TEXT
        );
    """)

    t0 = 1_743_465_600_000  # 2025-04-01 in ms
    conn.execute(
        "INSERT INTO session VALUES (?,?,?,?,?,?,?)",
        (OPENCODE_SESSION_ID, "proj-1", str(root / "proj"),
         "Refactor", "0.1.0", t0, t0 + 5000),
    )
    # Assistant message — cost field is present in data but must NOT be persisted.
    msg_data = {
        "role": "assistant",
        "modelID": "claude-sonnet-4-20250514",
        "providerID": "anthropic",
        "tokens": {
            "input": 75,
            "output": 150,
            "reasoning": 12,
            "cache": {"read": 40, "write": 5},
        },
        "cost": 0.00123,
        "finish": "tool-calls",
        "time": {"created": t0 + 1000, "completed": t0 + 4000},
    }
    conn.execute(
        "INSERT INTO message VALUES (?,?,?,?,?)",
        ("msg-1", OPENCODE_SESSION_ID, t0 + 1000, t0 + 4000, json.dumps(msg_data)),
    )
    # One tool part — should bump tool_calls to 1.
    # OpenCode stores compact JSON (Drizzle); the scanner's LIKE pattern
    # `%"type":"tool%` relies on no whitespace between key and value.
    conn.execute(
        "INSERT INTO part VALUES (?,?,?)",
        ("part-1", "msg-1",
         json.dumps({"type": "tool-invocation", "name": "Read"},
                    separators=(",", ":"))),
    )
    conn.commit()
    conn.close()
    return {"home": home, "db": db_path, "t0": t0}


# ─── monkeypatch helpers ─────────────────────────────────────────────────────

def _patch_copilot(monkeypatch, paths):
    monkeypatch.setattr(cp_mod, "COPILOT_HOME", str(paths["home"]))
    monkeypatch.setattr(cp_mod, "COPILOT_DB", str(paths["db"]))
    monkeypatch.setattr(cp_mod, "COPILOT_STATE", str(paths["state"]))


def _patch_claude(monkeypatch, paths):
    monkeypatch.setattr(cc_mod, "CLAUDE_HOME", str(paths["home"]))
    monkeypatch.setattr(cc_mod, "CLAUDE_PROJECTS", str(paths["projects"]))


def _patch_codex(monkeypatch, paths):
    monkeypatch.setattr(cx_mod, "CODEX_HOME", str(paths["home"]))
    monkeypatch.setattr(cx_mod, "CODEX_SESSIONS", str(paths["sessions_dir"]))


def _patch_opencode(monkeypatch, paths):
    monkeypatch.setattr(oc_mod, "_db_candidates", lambda: [str(paths["db"])])


# ─── pytest fixtures ─────────────────────────────────────────────────────────

@pytest.fixture
def copilot_paths(tmp_path, monkeypatch):
    paths = build_copilot_fixture(tmp_path)
    _patch_copilot(monkeypatch, paths)
    return paths


@pytest.fixture
def claude_paths(tmp_path, monkeypatch):
    paths = build_claude_fixture(tmp_path)
    _patch_claude(monkeypatch, paths)
    return paths


@pytest.fixture
def codex_paths(tmp_path, monkeypatch):
    paths = build_codex_fixture(tmp_path)
    _patch_codex(monkeypatch, paths)
    return paths


@pytest.fixture
def opencode_paths(tmp_path, monkeypatch):
    paths = build_opencode_fixture(tmp_path)
    _patch_opencode(monkeypatch, paths)
    return paths


# ════════════════════════════════════════════════════════════════════════════
# Detection tests
# ════════════════════════════════════════════════════════════════════════════

def test_copilot_detect_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(cp_mod, "COPILOT_HOME", str(tmp_path / "nope"))
    monkeypatch.setattr(cp_mod, "COPILOT_DB", str(tmp_path / "nope" / "session-store.db"))
    monkeypatch.setattr(cp_mod, "COPILOT_STATE", str(tmp_path / "nope" / "session-state"))
    assert CopilotScanner().detect().installed is False


def test_copilot_detect_present(copilot_paths):
    d = CopilotScanner().detect()
    assert d.installed is True
    assert d.data_path == str(copilot_paths["home"])


def test_claude_detect_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(cc_mod, "CLAUDE_HOME", str(tmp_path / "nope"))
    monkeypatch.setattr(cc_mod, "CLAUDE_PROJECTS", str(tmp_path / "nope" / "projects"))
    assert ClaudeCodeScanner().detect().installed is False


def test_claude_detect_present(claude_paths):
    assert ClaudeCodeScanner().detect().installed is True


def test_codex_detect_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(cx_mod, "CODEX_HOME", str(tmp_path / "nope"))
    monkeypatch.setattr(cx_mod, "CODEX_SESSIONS", str(tmp_path / "nope" / "sessions"))
    assert CodexScanner().detect().installed is False


def test_codex_detect_present(codex_paths):
    assert CodexScanner().detect().installed is True


def test_opencode_detect_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(oc_mod, "_db_candidates", lambda: [str(tmp_path / "nope.db")])
    assert OpenCodeScanner().detect().installed is False


def test_opencode_detect_present(opencode_paths):
    d = OpenCodeScanner().detect()
    assert d.installed is True
    assert d.data_path == str(opencode_paths["db"])


# ════════════════════════════════════════════════════════════════════════════
# Seed tests: metadata-only, cursors pinned to EOF / max updated
# ════════════════════════════════════════════════════════════════════════════

def test_copilot_seed(copilot_paths):
    result = CopilotScanner().seed()
    assert len(result.sessions) == 1
    assert len(result.turns) == 0
    s = result.sessions[0]
    assert s.native_id == COPILOT_SESSION_ID
    assert s.model == "gpt-5"
    ev_path = str(copilot_paths["events"])
    assert ev_path in result.updated_sources
    src = result.updated_sources[ev_path]
    assert src.last_offset == os.path.getsize(ev_path)


def test_claude_seed(claude_paths):
    result = ClaudeCodeScanner().seed()
    assert len(result.sessions) == 1
    assert len(result.turns) == 0
    path = str(claude_paths["path"])
    src = result.updated_sources[path]
    assert src.last_offset == os.path.getsize(path)
    assert result.sessions[0].model == "claude-sonnet-4-20250514"
    assert result.sessions[0].git_branch == "main"


def test_codex_seed(codex_paths):
    result = CodexScanner().seed()
    assert len(result.sessions) == 1
    assert len(result.turns) == 0
    s = result.sessions[0]
    assert s.native_id == CODEX_SESSION_ID
    assert s.cli_version == "0.42.0"
    assert s.provider == "openai"
    path = str(codex_paths["path"])
    assert result.updated_sources[path].last_offset == os.path.getsize(path)


def test_opencode_seed(opencode_paths):
    result = OpenCodeScanner().seed()
    assert len(result.sessions) == 1
    assert len(result.turns) == 0
    s = result.sessions[0]
    assert s.native_id == OPENCODE_SESSION_ID
    assert s.title == "Refactor"
    src_key = f"sqlite:{opencode_paths['db']}"
    assert src_key in result.updated_sources
    assert result.updated_sources[src_key].last_mtime == opencode_paths["t0"] + 5000


# ════════════════════════════════════════════════════════════════════════════
# scan({}) with no cursors behaves like seed (no turns)
# ════════════════════════════════════════════════════════════════════════════

def test_copilot_scan_empty_is_seed(copilot_paths):
    result = CopilotScanner().scan({})
    # No cursor known → new-session branch, no turns emitted.
    assert len(result.turns) == 0
    assert len(result.sessions) == 1


def test_claude_scan_empty_is_seed(claude_paths):
    result = ClaudeCodeScanner().scan({})
    assert len(result.turns) == 0
    assert len(result.sessions) == 1


def test_codex_scan_empty_is_seed(codex_paths):
    result = CodexScanner().scan({})
    assert len(result.turns) == 0
    assert len(result.sessions) == 1


def test_opencode_scan_empty_is_seed(opencode_paths):
    result = OpenCodeScanner().scan({})
    assert len(result.turns) == 0
    assert len(result.sessions) == 1


# ════════════════════════════════════════════════════════════════════════════
# scan() with cursor at 0 (rewound) yields turns matching assistant-count
# ════════════════════════════════════════════════════════════════════════════

def test_copilot_scan_rewound_yields_turns(copilot_paths):
    from usage.types import AgentSource
    ev_path = str(copilot_paths["events"])
    cursor = {ev_path: AgentSource(agent="copilot", source_path=ev_path,
                                   last_offset=0, last_mtime=0)}
    result = CopilotScanner().scan(cursor)
    assert len(result.turns) == 2
    t0, t1 = result.turns
    assert t0.output_tokens == 42
    assert t0.tool_calls == 1
    assert t0.model == "gpt-5"
    assert t1.output_tokens == 17
    assert t1.tool_calls == 0
    # Cursor advanced past EOF.
    assert result.updated_sources[ev_path].last_offset == os.path.getsize(ev_path)


def test_claude_scan_rewound_yields_turns(claude_paths):
    from usage.types import AgentSource
    path = str(claude_paths["path"])
    cursor = {path: AgentSource(agent="claude-code", source_path=path,
                                last_offset=0, last_mtime=0)}
    result = ClaudeCodeScanner().scan(cursor)
    assert len(result.turns) == 2
    t0 = result.turns[0]
    assert t0.input_tokens == 100
    assert t0.cached_input_tokens == 60   # 50 read + 10 creation
    assert t0.output_tokens == 200
    assert t0.reasoning_tokens == 0
    assert t0.total_tokens == 360
    assert t0.tool_calls == 1
    assert t0.finish_reason == "tool_use"
    t1 = result.turns[1]
    assert t1.cached_input_tokens == 80
    assert t1.tool_calls == 0
    assert t1.finish_reason == "end_turn"


def test_codex_scan_rewound_yields_turns(codex_paths):
    from usage.types import AgentSource
    path = str(codex_paths["path"])
    cursor = {path: AgentSource(agent="codex", source_path=path,
                                last_offset=0, last_mtime=0)}
    result = CodexScanner().scan(cursor)
    assert len(result.turns) == 2
    t0 = result.turns[0]
    assert t0.input_tokens == 400
    assert t0.cached_input_tokens == 100
    assert t0.output_tokens == 60
    assert t0.reasoning_tokens == 25
    assert t0.total_tokens == 585
    assert t0.tool_calls == 1
    assert t0.model == "gpt-5-codex"
    t1 = result.turns[1]
    assert t1.input_tokens == 120
    assert t1.reasoning_tokens == 10
    assert t1.tool_calls == 0


def test_opencode_scan_rewound_yields_turns(opencode_paths):
    from usage.types import AgentSource
    src = f"sqlite:{opencode_paths['db']}"
    cursor = {src: AgentSource(agent="opencode", source_path=src,
                               last_offset=0, last_mtime=0)}
    result = OpenCodeScanner().scan(cursor)
    assert len(result.turns) == 1
    t = result.turns[0]
    assert t.input_tokens == 75
    assert t.output_tokens == 150
    assert t.reasoning_tokens == 12
    assert t.cached_input_tokens == 45  # 40 read + 5 write
    assert t.model == "claude-sonnet-4-20250514"
    assert t.provider == "anthropic"
    assert t.finish_reason == "tool-calls"
    assert t.tool_calls == 1


# ════════════════════════════════════════════════════════════════════════════
# scan() with cursor at EOF returns no new turns (forward-only)
# ════════════════════════════════════════════════════════════════════════════

def test_copilot_scan_eof_is_empty(copilot_paths):
    from usage.types import AgentSource
    ev_path = str(copilot_paths["events"])
    st = os.stat(ev_path)
    cursor = {ev_path: AgentSource(agent="copilot", source_path=ev_path,
                                   last_offset=st.st_size,
                                   last_mtime=int(st.st_mtime * 1000))}
    result = CopilotScanner().scan(cursor)
    assert result.turns == []


def test_claude_scan_eof_is_empty(claude_paths):
    from usage.types import AgentSource
    path = str(claude_paths["path"])
    st = os.stat(path)
    cursor = {path: AgentSource(agent="claude-code", source_path=path,
                                last_offset=st.st_size,
                                last_mtime=int(st.st_mtime * 1000))}
    result = ClaudeCodeScanner().scan(cursor)
    assert result.turns == []


def test_codex_scan_eof_is_empty(codex_paths):
    from usage.types import AgentSource
    path = str(codex_paths["path"])
    st = os.stat(path)
    cursor = {path: AgentSource(agent="codex", source_path=path,
                                last_offset=st.st_size,
                                last_mtime=int(st.st_mtime * 1000))}
    result = CodexScanner().scan(cursor)
    assert result.turns == []


def test_opencode_scan_eof_is_empty(opencode_paths):
    from usage.types import AgentSource
    src = f"sqlite:{opencode_paths['db']}"
    cursor = {src: AgentSource(agent="opencode", source_path=src,
                               last_offset=0,
                               last_mtime=opencode_paths["t0"] + 5000)}
    result = OpenCodeScanner().scan(cursor)
    assert result.turns == []


# ════════════════════════════════════════════════════════════════════════════
# JSONL partial-line safety (copilot / claude / codex)
# ════════════════════════════════════════════════════════════════════════════

def _append_partial_line(path: Path) -> None:
    """Append a JSON object that has no trailing newline (simulates in-flight write)."""
    with path.open("a", encoding="utf-8", newline="\n") as f:
        f.write('{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":2}')


def test_copilot_partial_line_safety(copilot_paths):
    from usage.types import AgentSource
    ev_path = copilot_paths["events"]
    # First, advance cursor to EOF.
    scanner = CopilotScanner()
    result = scanner.scan({
        str(ev_path): AgentSource(agent="copilot", source_path=str(ev_path),
                                  last_offset=0, last_mtime=0)
    })
    end_offset = result.updated_sources[str(ev_path)].last_offset
    # Append a half-written line.
    _append_partial_line(ev_path)
    # Re-scan from end_offset: should NOT advance past the end, no exception.
    cursor = {str(ev_path): AgentSource(
        agent="copilot", source_path=str(ev_path),
        last_offset=end_offset,
        last_mtime=result.updated_sources[str(ev_path)].last_mtime,
    )}
    result2 = scanner.scan(cursor)
    # read_jsonl_incremental returned no complete lines → scanner either
    # didn't update the cursor at all (no key in updated_sources) or kept
    # last_offset at end_offset. Either way, no crash and no advancement.
    if str(ev_path) in result2.updated_sources:
        assert result2.updated_sources[str(ev_path)].last_offset == end_offset
    assert result2.turns == []


def test_claude_partial_line_safety(claude_paths):
    path = claude_paths["path"]
    # Try the JSONL reader directly — scanner-level behavior is the same.
    end = os.path.getsize(path)
    mt = int(os.stat(path).st_mtime * 1000)
    _append_partial_line(path)
    lines, new_offset, _ = read_jsonl_incremental(str(path), end, mt)
    assert lines == []
    assert new_offset == end


def test_codex_partial_line_safety(codex_paths):
    path = codex_paths["path"]
    end = os.path.getsize(path)
    mt = int(os.stat(path).st_mtime * 1000)
    _append_partial_line(path)
    lines, new_offset, _ = read_jsonl_incremental(str(path), end, mt)
    assert lines == []
    assert new_offset == end


# ════════════════════════════════════════════════════════════════════════════
# Regression: cursor advanced past session_meta still yields attributed turns.
# Before the fix, an incremental scan whose new byte range didn't include the
# first-line session_meta/sessionId would emit TurnRows with
# native_session_id="", producing sid="codex:"/"claude-code:" on write and
# violating the agent_turns FK to agent_sessions.id — rolling back the ingest
# txn and surfacing as HTTP 500 on /api/agent-usage.
# ════════════════════════════════════════════════════════════════════════════

def _append_codex_turn(path, seq_timestamp: str):
    with open(path, "a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({
            "type": "event_msg",
            "timestamp": seq_timestamp,
            "payload": {"type": "task_started"},
        }) + "\n")
        f.write(json.dumps({
            "type": "event_msg",
            "timestamp": seq_timestamp,
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": 10,
                        "cached_input_tokens": 0,
                        "output_tokens": 20,
                        "reasoning_output_tokens": 0,
                        "total_tokens": 30,
                    },
                },
            },
        }) + "\n")


def _append_claude_turn(path, ts: str):
    with open(path, "a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({
            "type": "assistant",
            "sessionId": CLAUDE_SESSION_ID,
            "timestamp": ts,
            "cwd": "/some/cwd",
            "message": {
                "model": "claude-sonnet-4-20250514",
                "usage": {"input_tokens": 5, "output_tokens": 10},
                "stop_reason": "end_turn",
                "content": [{"type": "text", "text": "ok"}],
            },
        }) + "\n")


def test_codex_scan_past_session_meta_yields_attributed_turns(codex_paths):
    """Pin cursor past session_meta, append a new turn, verify attribution."""
    from usage.types import AgentSource
    path = str(codex_paths["path"])
    st = os.stat(path)
    # Cursor at EOF — session_meta is now behind us.
    cursor = {path: AgentSource(agent="codex", source_path=path,
                                last_offset=st.st_size,
                                last_mtime=int(st.st_mtime * 1000))}
    _append_codex_turn(path, "2026-04-01T00:01:00Z")

    result = CodexScanner().scan(cursor)

    assert len(result.turns) == 1, "new token_count event should produce a turn"
    turn = result.turns[0]
    assert turn.native_session_id == CODEX_SESSION_ID, \
        "turn must be attributed to the session from the file head"
    assert turn.model == "gpt-5-codex"
    # SessionRow must be emitted (for updated_at bump) even though no in-range session_meta.
    assert len(result.sessions) == 1
    assert result.sessions[0].native_id == CODEX_SESSION_ID


def test_claude_scan_past_metadata_yields_attributed_turns(claude_paths):
    from usage.types import AgentSource
    path = str(claude_paths["path"])
    st = os.stat(path)
    cursor = {path: AgentSource(agent="claude-code", source_path=path,
                                last_offset=st.st_size,
                                last_mtime=int(st.st_mtime * 1000))}
    _append_claude_turn(path, "2026-04-01T00:01:00Z")

    result = ClaudeCodeScanner().scan(cursor)

    assert len(result.turns) == 1
    turn = result.turns[0]
    assert turn.native_session_id == CLAUDE_SESSION_ID
    assert len(result.sessions) == 1
    assert result.sessions[0].native_id == CLAUDE_SESSION_ID


def test_codex_scan_past_meta_write_does_not_violate_fk(codex_paths, taskbean_conn):
    """End-to-end: seed → cursor past meta → append turn → write_scan_result succeeds."""
    from usage.types import AgentSource
    path = str(codex_paths["path"])
    # First, persist the seeded session so the FK target exists.
    seed = CodexScanner().seed()
    usage_db.write_scan_result(taskbean_conn, "codex", seed)

    # Now: cursor advanced past session_meta, append a new turn, scan+write.
    st = os.stat(path)
    cursor = {path: AgentSource(agent="codex", source_path=path,
                                last_offset=st.st_size,
                                last_mtime=int(st.st_mtime * 1000))}
    _append_codex_turn(path, "2026-04-01T00:02:00Z")

    result = CodexScanner().scan(cursor)
    # Would have raised sqlite3.IntegrityError: FOREIGN KEY constraint failed
    # before the fix.
    usage_db.write_scan_result(taskbean_conn, "codex", result)

    n_turns = taskbean_conn.execute(
        "SELECT COUNT(*) FROM agent_turns WHERE agent='codex'"
    ).fetchone()[0]
    assert n_turns == 1
    sid_row = taskbean_conn.execute(
        "SELECT session_id FROM agent_turns WHERE agent='codex'"
    ).fetchone()
    assert sid_row["session_id"] == f"codex:{CODEX_SESSION_ID}"


def test_claude_scan_past_meta_write_does_not_violate_fk(claude_paths, taskbean_conn):
    from usage.types import AgentSource
    path = str(claude_paths["path"])
    seed = ClaudeCodeScanner().seed()
    usage_db.write_scan_result(taskbean_conn, "claude-code", seed)

    st = os.stat(path)
    cursor = {path: AgentSource(agent="claude-code", source_path=path,
                                last_offset=st.st_size,
                                last_mtime=int(st.st_mtime * 1000))}
    _append_claude_turn(path, "2026-04-01T00:02:00Z")

    result = ClaudeCodeScanner().scan(cursor)
    usage_db.write_scan_result(taskbean_conn, "claude-code", result)

    sid_row = taskbean_conn.execute(
        "SELECT session_id FROM agent_turns WHERE agent='claude-code' "
        "ORDER BY occurred_at DESC LIMIT 1"
    ).fetchone()
    assert sid_row["session_id"] == f"claude-code:{CLAUDE_SESSION_ID}"


# ════════════════════════════════════════════════════════════════════════════
# OpenCode: cost field must NOT surface in TurnRow or SessionRow
# ════════════════════════════════════════════════════════════════════════════

def test_opencode_cost_not_persisted(opencode_paths):
    from dataclasses import asdict, fields
    from usage.types import AgentSource, TurnRow, SessionRow
    src = f"sqlite:{opencode_paths['db']}"
    cursor = {src: AgentSource(agent="opencode", source_path=src,
                               last_offset=0, last_mtime=0)}
    result = OpenCodeScanner().scan(cursor)

    # `cost` must not exist as a field on either dataclass…
    turn_fields = {f.name for f in fields(TurnRow)}
    sess_fields = {f.name for f in fields(SessionRow)}
    assert "cost" not in turn_fields
    assert "cost" not in sess_fields

    # …and must not sneak in as an attribute value either.
    for t in result.turns:
        assert "cost" not in asdict(t)
    for s in result.sessions:
        assert "cost" not in asdict(s)


# ════════════════════════════════════════════════════════════════════════════
# Writer integration: end-to-end DB roundtrip + idempotency
# ════════════════════════════════════════════════════════════════════════════

# DDL copied from cli/src/data/store.js — kept in-sync manually.
_DDL = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    tracked INTEGER DEFAULT 0,
    skill_installed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    native_id TEXT NOT NULL,
    cwd TEXT,
    project_id TEXT,
    title TEXT,
    model TEXT,
    provider TEXT,
    cli_version TEXT,
    git_branch TEXT,
    source_path TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    UNIQUE (agent, native_id)
);
CREATE TABLE IF NOT EXISTS agent_turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    agent TEXT NOT NULL,
    seq INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    model TEXT,
    provider TEXT,
    input_tokens INTEGER DEFAULT 0,
    cached_input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    tool_calls INTEGER DEFAULT 0,
    finish_reason TEXT,
    UNIQUE (session_id, seq)
);
CREATE TABLE IF NOT EXISTS agent_sources (
    agent TEXT NOT NULL,
    source_path TEXT NOT NULL,
    last_offset INTEGER DEFAULT 0,
    last_mtime INTEGER DEFAULT 0,
    last_native_id TEXT,
    scanned_at TEXT NOT NULL,
    PRIMARY KEY (agent, source_path)
);
CREATE TABLE IF NOT EXISTS agent_settings (
    agent TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    detected_at TEXT,
    last_active_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    project TEXT,
    project_path TEXT,
    agent TEXT,
    agent_session_id TEXT,
    created_at TEXT NOT NULL
);
"""


@pytest.fixture
def taskbean_conn(tmp_path, monkeypatch):
    """Point TASKBEAN_DB at a tempfile, bootstrap schema, yield a fresh connection."""
    db_file = tmp_path / "taskbean.db"
    monkeypatch.setenv("TASKBEAN_DB", str(db_file))
    monkeypatch.setenv("TASKBEAN_HOME", str(tmp_path))

    # Bootstrap schema using a vanilla connection (avoids WAL/PRAGMA overhead).
    boot = sqlite3.connect(db_file)
    boot.executescript(_DDL)
    boot.commit()
    boot.close()

    conn = usage_db.connect()
    try:
        yield conn
    finally:
        conn.close()


def test_writer_roundtrip_and_idempotent(copilot_paths, taskbean_conn):
    from usage.types import AgentSource
    ev_path = str(copilot_paths["events"])
    cursor = {ev_path: AgentSource(agent="copilot", source_path=ev_path,
                                   last_offset=0, last_mtime=0)}
    scanner = CopilotScanner()
    result = scanner.scan(cursor)
    assert len(result.turns) == 2

    usage_db.write_scan_result(taskbean_conn, "copilot", result)

    # Sessions row inserted.
    n_sess = taskbean_conn.execute(
        "SELECT COUNT(*) FROM agent_sessions WHERE agent='copilot'"
    ).fetchone()[0]
    assert n_sess == 1

    # Two turn rows.
    n_turns = taskbean_conn.execute(
        "SELECT COUNT(*) FROM agent_turns WHERE agent='copilot'"
    ).fetchone()[0]
    assert n_turns == 2

    # Cursor persisted.
    row = taskbean_conn.execute(
        "SELECT last_offset FROM agent_sources WHERE agent='copilot' AND source_path=?",
        (ev_path,),
    ).fetchone()
    assert row["last_offset"] == os.path.getsize(ev_path)

    # Idempotency: writing the SAME scan result again must not duplicate turns.
    usage_db.write_scan_result(taskbean_conn, "copilot", result)
    n_turns_after = taskbean_conn.execute(
        "SELECT COUNT(*) FROM agent_turns WHERE agent='copilot'"
    ).fetchone()[0]
    assert n_turns_after == 2

    # agent_settings row was created / updated with last_active_at.
    st = taskbean_conn.execute(
        "SELECT enabled, last_active_at FROM agent_settings WHERE agent='copilot'"
    ).fetchone()
    assert st is not None
    assert st["enabled"] == 1


# ─── backfill_todo_sessions ─────────────────────────────────────────────────

def _insert_project(conn, pid, name, path):
    conn.execute(
        "INSERT INTO projects (id, name, path, tracked) VALUES (?, ?, ?, 1)",
        (pid, name, path),
    )


def _insert_session(conn, agent, native_id, project_id, started_at, updated_at):
    conn.execute(
        """INSERT INTO agent_sessions
           (id, agent, native_id, cwd, project_id, source_path,
            started_at, updated_at, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (f"{agent}:{native_id}", agent, native_id, f"/tmp/{project_id}",
         project_id, f"/tmp/{agent}.jsonl", started_at, updated_at, updated_at),
    )


def _insert_todo(conn, tid, project, agent, created_at):
    conn.execute(
        "INSERT INTO todos (id, title, project, agent, created_at) VALUES (?, ?, ?, ?, ?)",
        (tid, f"todo-{tid}", project, agent, created_at),
    )


def test_backfill_links_orphan_todos_to_session(taskbean_conn):
    _insert_project(taskbean_conn, "proj1", "proj1", "/tmp/proj1")
    _insert_session(taskbean_conn, "copilot", "nat-1", "proj1",
                    "2026-04-16T17:00:00Z", "2026-04-16T17:10:00Z")
    # Todo created during the session window.
    _insert_todo(taskbean_conn, "t1", "proj1", "copilot",
                 "2026-04-16T17:05:00Z")

    n = usage_db.backfill_todo_sessions(taskbean_conn)
    assert n == 1
    row = taskbean_conn.execute(
        "SELECT agent_session_id FROM todos WHERE id='t1'"
    ).fetchone()
    assert row["agent_session_id"] == "copilot:nat-1"


def test_backfill_picks_closest_session_on_multiple_matches(taskbean_conn):
    _insert_project(taskbean_conn, "proj1", "proj1", "/tmp/proj1")
    _insert_session(taskbean_conn, "codex", "older", "proj1",
                    "2026-04-16T17:00:00Z", "2026-04-16T17:10:00Z")
    _insert_session(taskbean_conn, "codex", "closer", "proj1",
                    "2026-04-16T17:12:00Z", "2026-04-16T17:20:00Z")
    # Todo closer to the second session.
    _insert_todo(taskbean_conn, "t1", "proj1", "codex",
                 "2026-04-16T17:13:00Z")

    usage_db.backfill_todo_sessions(taskbean_conn)
    row = taskbean_conn.execute(
        "SELECT agent_session_id FROM todos WHERE id='t1'"
    ).fetchone()
    assert row["agent_session_id"] == "codex:closer"


def test_backfill_respects_agent_match(taskbean_conn):
    _insert_project(taskbean_conn, "proj1", "proj1", "/tmp/proj1")
    # Session is claude-code; todo claims codex → should NOT match.
    _insert_session(taskbean_conn, "claude-code", "nat-1", "proj1",
                    "2026-04-16T17:00:00Z", "2026-04-16T17:10:00Z")
    _insert_todo(taskbean_conn, "t1", "proj1", "codex",
                 "2026-04-16T17:05:00Z")

    n = usage_db.backfill_todo_sessions(taskbean_conn)
    assert n == 0
    row = taskbean_conn.execute(
        "SELECT agent_session_id FROM todos WHERE id='t1'"
    ).fetchone()
    assert row["agent_session_id"] is None


def test_backfill_respects_time_window(taskbean_conn):
    _insert_project(taskbean_conn, "proj1", "proj1", "/tmp/proj1")
    _insert_session(taskbean_conn, "opencode", "nat-1", "proj1",
                    "2026-04-16T10:00:00Z", "2026-04-16T10:10:00Z")
    # Todo >30 min after session's updated_at → outside window.
    _insert_todo(taskbean_conn, "t1", "proj1", "opencode",
                 "2026-04-16T12:00:00Z")

    n = usage_db.backfill_todo_sessions(taskbean_conn)
    assert n == 0


def test_backfill_skips_already_linked_todos(taskbean_conn):
    _insert_project(taskbean_conn, "proj1", "proj1", "/tmp/proj1")
    _insert_session(taskbean_conn, "copilot", "nat-1", "proj1",
                    "2026-04-16T17:00:00Z", "2026-04-16T17:10:00Z")
    # Todo already linked to a different session id → backfill must not touch it.
    taskbean_conn.execute(
        "INSERT INTO todos (id, title, project, agent, agent_session_id, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ("t1", "already-linked", "proj1", "copilot", "copilot:prelinked",
         "2026-04-16T17:05:00Z"),
    )

    n = usage_db.backfill_todo_sessions(taskbean_conn)
    assert n == 0
    row = taskbean_conn.execute(
        "SELECT agent_session_id FROM todos WHERE id='t1'"
    ).fetchone()
    assert row["agent_session_id"] == "copilot:prelinked"


# ─── B1: schema bootstrap on legacy DBs ─────────────────────────────────────

def _legacy_todos_only_ddl(conn: sqlite3.Connection) -> None:
    """Simulate an old ~/.taskbean/taskbean.db that predates usage tracking."""
    conn.executescript("""
        CREATE TABLE todos (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            completed INTEGER DEFAULT 0,
            source TEXT DEFAULT 'manual',
            created_at TEXT NOT NULL
        );
    """)
    conn.commit()


def test_schema_bootstrap_creates_usage_tables(tmp_path, monkeypatch):
    """B1: connect() on a legacy-only DB auto-creates all usage tables."""
    db_file = tmp_path / "taskbean.db"
    monkeypatch.setenv("TASKBEAN_DB", str(db_file))
    monkeypatch.setenv("TASKBEAN_HOME", str(tmp_path))

    # Seed legacy schema.
    legacy = sqlite3.connect(db_file)
    _legacy_todos_only_ddl(legacy)
    legacy.close()

    conn = usage_db.connect()
    try:
        tables = {
            r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        assert {"agent_sessions", "agent_turns", "agent_sources",
                "agent_settings", "projects"}.issubset(tables)

        # todos columns exist (agent, agent_session_id, project_path).
        cols = {r[1] for r in conn.execute("PRAGMA table_info(todos)")}
        assert {"agent", "agent_session_id", "project_path"}.issubset(cols)
    finally:
        conn.close()


def test_schema_bootstrap_get_agent_usage_on_fresh_db(tmp_path, monkeypatch):
    """B1: get_agent_usage against a bootstrapped legacy DB returns empty, no crash."""
    import asyncio
    from usage import ingest as ui

    db_file = tmp_path / "taskbean.db"
    monkeypatch.setenv("TASKBEAN_DB", str(db_file))
    monkeypatch.setenv("TASKBEAN_HOME", str(tmp_path))

    legacy = sqlite3.connect(db_file)
    _legacy_todos_only_ddl(legacy)
    legacy.close()

    # Disable scanners so detection doesn't write anything.
    monkeypatch.setattr(ui, "all_scanners", lambda: [])

    result = asyncio.run(ui.get_agent_usage(period="today", skip_ingest=True))
    assert result["totals"]["turns"] == 0
    assert result["totals"]["sessions"] == 0
    assert result["details"] == []
    # byAgent may contain zero-counter defaults; what matters is no crash
    # and no turn activity on a freshly-bootstrapped DB.
    for agent_stats in result["byAgent"].values():
        assert agent_stats["turns"] == 0
        assert agent_stats["totalTokens"] == 0


def test_schema_bootstrap_idempotent(tmp_path, monkeypatch):
    """connect() called twice on the same DB doesn't error."""
    db_file = tmp_path / "taskbean.db"
    monkeypatch.setenv("TASKBEAN_DB", str(db_file))
    monkeypatch.setenv("TASKBEAN_HOME", str(tmp_path))

    c1 = usage_db.connect()
    c1.close()
    c2 = usage_db.connect()
    c2.close()


# ─── B2: project-path vs name-based backfill ────────────────────────────────

def test_backfill_path_match_wins_over_name(taskbean_conn):
    """B2: project_path pins identity even when two projects share a name."""
    _insert_project(taskbean_conn, "app-a", "app", "/home/dev/app-a")
    _insert_project(taskbean_conn, "app-b", "app", "/home/dev/app-b")
    _insert_session(taskbean_conn, "copilot", "nat-a", "app-a",
                    "2026-04-16T17:00:00Z", "2026-04-16T17:10:00Z")
    _insert_session(taskbean_conn, "copilot", "nat-b", "app-b",
                    "2026-04-16T17:00:00Z", "2026-04-16T17:10:00Z")

    # Todo with project_path → unambiguous, binds to app-b.
    taskbean_conn.execute(
        "INSERT INTO todos (id, title, project, project_path, agent, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ("t1", "x", "app", "/home/dev/app-b", "copilot",
         "2026-04-16T17:05:00Z"),
    )

    n = usage_db.backfill_todo_sessions(taskbean_conn)
    assert n == 1
    row = taskbean_conn.execute(
        "SELECT agent_session_id FROM todos WHERE id='t1'"
    ).fetchone()
    assert row["agent_session_id"] == "copilot:nat-b"


def test_backfill_skips_ambiguous_name_without_path(taskbean_conn):
    """B2: two projects share a name AND project_path is NULL → skip, don't guess."""
    _insert_project(taskbean_conn, "app-a", "app", "/home/dev/app-a")
    _insert_project(taskbean_conn, "app-b", "app", "/home/dev/app-b")
    _insert_session(taskbean_conn, "copilot", "nat-a", "app-a",
                    "2026-04-16T17:00:00Z", "2026-04-16T17:10:00Z")
    _insert_session(taskbean_conn, "copilot", "nat-b", "app-b",
                    "2026-04-16T17:00:00Z", "2026-04-16T17:10:00Z")
    _insert_todo(taskbean_conn, "t1", "app", "copilot",
                 "2026-04-16T17:05:00Z")

    n = usage_db.backfill_todo_sessions(taskbean_conn)
    assert n == 0
    row = taskbean_conn.execute(
        "SELECT agent_session_id FROM todos WHERE id='t1'"
    ).fetchone()
    assert row["agent_session_id"] is None


def test_backfill_path_match_case_insensitive(taskbean_conn):
    """B2: Windows path casing differences shouldn't break the join."""
    _insert_project(taskbean_conn, "proj1", "proj1", r"C:\Users\dev\ProJ1")
    _insert_session(taskbean_conn, "copilot", "nat-1", "proj1",
                    "2026-04-16T17:00:00Z", "2026-04-16T17:10:00Z")
    taskbean_conn.execute(
        "INSERT INTO todos (id, title, project, project_path, agent, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ("t1", "x", "proj1", r"c:\users\dev\proj1", "copilot",
         "2026-04-16T17:05:00Z"),
    )
    n = usage_db.backfill_todo_sessions(taskbean_conn)
    assert n == 1


def test_backfill_skips_ambiguous_session_window(taskbean_conn):
    """B2: two sessions ~equidistant in time → don't coin-flip."""
    _insert_project(taskbean_conn, "proj1", "proj1", "/tmp/proj1")
    # Two sessions very close to the same todo timestamp.
    _insert_session(taskbean_conn, "copilot", "nat-a", "proj1",
                    "2026-04-16T17:04:00Z", "2026-04-16T17:14:00Z")
    _insert_session(taskbean_conn, "copilot", "nat-b", "proj1",
                    "2026-04-16T17:06:00Z", "2026-04-16T17:16:00Z")
    _insert_todo(taskbean_conn, "t1", "proj1", "copilot",
                 "2026-04-16T17:05:00Z")  # 1 min from each

    n = usage_db.backfill_todo_sessions(taskbean_conn)
    assert n == 0


def test_backfill_picks_clearly_closer_session(taskbean_conn):
    """B2 sanity: when one session is >2× closer, pick it."""
    _insert_project(taskbean_conn, "proj1", "proj1", "/tmp/proj1")
    _insert_session(taskbean_conn, "copilot", "close", "proj1",
                    "2026-04-16T17:04:00Z", "2026-04-16T17:14:00Z")
    _insert_session(taskbean_conn, "copilot", "far", "proj1",
                    "2026-04-16T16:50:00Z", "2026-04-16T17:20:00Z")
    _insert_todo(taskbean_conn, "t1", "proj1", "copilot",
                 "2026-04-16T17:05:00Z")  # ~1min from close, ~15min from far

    n = usage_db.backfill_todo_sessions(taskbean_conn)
    assert n == 1
    row = taskbean_conn.execute(
        "SELECT agent_session_id FROM todos WHERE id='t1'"
    ).fetchone()
    assert row["agent_session_id"] == "copilot:close"


def test_backfill_path_pointing_to_unknown_project_skips(taskbean_conn):
    """B2: project_path set but no matching projects row → skip (don't fall back to name)."""
    _insert_project(taskbean_conn, "proj1", "proj1", "/home/real/proj1")
    _insert_session(taskbean_conn, "copilot", "nat-1", "proj1",
                    "2026-04-16T17:00:00Z", "2026-04-16T17:10:00Z")
    taskbean_conn.execute(
        "INSERT INTO todos (id, title, project, project_path, agent, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ("t1", "x", "proj1", "/some/other/path", "copilot",
         "2026-04-16T17:05:00Z"),
    )
    n = usage_db.backfill_todo_sessions(taskbean_conn)
    assert n == 0


# ─── B5: short-circuit on empty orphan set ──────────────────────────────────

def test_backfill_short_circuits_when_no_orphans(taskbean_conn):
    """B5: no orphan todos → return 0 without running the CTE / UPDATE."""
    _insert_project(taskbean_conn, "proj1", "proj1", "/tmp/proj1")
    _insert_session(taskbean_conn, "copilot", "nat-1", "proj1",
                    "2026-04-16T17:00:00Z", "2026-04-16T17:10:00Z")
    # Zero todos at all.
    assert usage_db.backfill_todo_sessions(taskbean_conn) == 0

    # Now insert a todo that's already linked → still a fast-path return.
    taskbean_conn.execute(
        "INSERT INTO todos (id, title, project, agent, agent_session_id, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ("t1", "x", "proj1", "copilot", "copilot:nat-1",
         "2026-04-16T17:05:00Z"),
    )
    assert usage_db.backfill_todo_sessions(taskbean_conn) == 0


# ─── B6: rotation logging ───────────────────────────────────────────────────

def test_jsonl_reader_logs_on_rotation(tmp_path, caplog):
    """B6: truncation triggers a single info-level log with the old offset."""
    import logging as _logging
    path = tmp_path / "rot.jsonl"
    # Write a small file, then "rotate" by shrinking it below last_offset.
    path.write_text('{"a":1}\n{"a":2}\n', encoding="utf-8")
    size = os.path.getsize(path)

    with caplog.at_level(_logging.INFO, logger="usage.scanner"):
        # Simulate a cursor past EOF (file rotated and re-created smaller).
        lines, new_offset, _ = read_jsonl_incremental(
            str(path), last_offset=size + 100, last_mtime=0,
        )
    # Rotation detected → offset was reset to 0 → both lines read back.
    assert len(lines) == 2
    assert new_offset == size
    assert any(
        "rotated" in rec.getMessage() and "rot.jsonl" in rec.getMessage()
        for rec in caplog.records
    ), "expected a rotation info log"


# ─── B7: don't emit zero-token turns ────────────────────────────────────────

def test_claude_skips_zero_token_turn(tmp_path, monkeypatch):
    """B7: an assistant message with usage={} (all zeros) and no tool_use → no turn."""
    from usage.types import AgentSource
    home = tmp_path / ".claude"
    projects = home / "projects"
    path = projects / "dir" / f"{CLAUDE_SESSION_ID}.jsonl"
    _write_jsonl(path, [
        {"type": "user", "sessionId": CLAUDE_SESSION_ID,
         "timestamp": "2026-04-01T00:00:00Z",
         "cwd": str(tmp_path), "message": {"role": "user", "content": "hi"}},
        # All-zero usage, no tool_use content block.
        {"type": "assistant", "sessionId": CLAUDE_SESSION_ID,
         "timestamp": "2026-04-01T00:00:05Z",
         "cwd": str(tmp_path),
         "message": {
             "model": "claude-sonnet-4-20250514",
             "usage": {"input_tokens": 0, "output_tokens": 0},
             "stop_reason": "end_turn",
             "content": [{"type": "text", "text": ""}],
         }},
    ])
    monkeypatch.setattr(cc_mod, "CLAUDE_HOME", str(home))
    monkeypatch.setattr(cc_mod, "CLAUDE_PROJECTS", str(projects))

    cursor = {str(path): AgentSource(agent="claude-code", source_path=str(path),
                                     last_offset=0, last_mtime=0)}
    result = ClaudeCodeScanner().scan(cursor)
    assert result.turns == []


def test_codex_skips_zero_token_turn(tmp_path, monkeypatch):
    """B7: Codex heartbeat token_count with all zeros and no tool_call → no turn."""
    from usage.types import AgentSource
    home = tmp_path / ".codex"
    sessions_dir = home / "sessions" / "2026" / "04" / "01"
    path = sessions_dir / f"rollout-2026-04-01T00-00-00-{CODEX_SESSION_ID}.jsonl"
    _write_jsonl(path, [
        {"type": "session_meta",
         "timestamp": "2026-04-01T00:00:00Z",
         "payload": {"id": CODEX_SESSION_ID,
                     "cwd": str(tmp_path),
                     "model": "gpt-5-codex",
                     "model_provider": "openai"}},
        # All-zero token_count with no tool activity.
        {"type": "event_msg",
         "timestamp": "2026-04-01T00:00:02Z",
         "payload": {"type": "token_count",
                     "info": {"last_token_usage": {
                         "input_tokens": 0, "output_tokens": 0,
                         "reasoning_output_tokens": 0, "total_tokens": 0,
                     }}}},
    ])
    monkeypatch.setattr(cx_mod, "CODEX_HOME", str(home))
    monkeypatch.setattr(cx_mod, "CODEX_SESSIONS", str(home / "sessions"))

    cursor = {str(path): AgentSource(agent="codex", source_path=str(path),
                                     last_offset=0, last_mtime=0)}
    result = CodexScanner().scan(cursor)
    assert result.turns == []


# ─── B3: /api/todos merges DB-written rows ──────────────────────────────────

def test_api_todos_merges_db_rows(tmp_path, monkeypatch):
    """B3: a CLI-written todo absent from in-memory state still surfaces via /api/todos."""
    import asyncio

    db_file = tmp_path / "taskbean.db"
    monkeypatch.setenv("TASKBEAN_DB", str(db_file))
    monkeypatch.setenv("TASKBEAN_HOME", str(tmp_path))

    # Bootstrap + seed.
    conn = usage_db.connect()
    conn.execute(
        "INSERT INTO todos (id, title, completed, source, priority, tags, project, created_at) "
        "VALUES (?, ?, 0, 'agent', 'none', '[]', ?, ?)",
        ("cli-only-1", "bean add this", "demo", "2026-04-16T17:05:00Z"),
    )
    conn.close()

    import main as main_mod

    def _override_db():
        import sqlite3 as _sq
        c = _sq.connect(f"file:{db_file}?mode=ro", uri=True)
        c.row_factory = _sq.Row
        return c
    monkeypatch.setattr(main_mod, "_get_taskbean_db", _override_db)

    # Call the handler coroutine directly — avoids TestClient + lifespan
    # startup (Jaeger docker, telemetry pipelines) which we don't need here.
    original_todos = list(main_mod.state_mod.todos)
    main_mod.state_mod.todos.clear()
    try:
        items = asyncio.run(main_mod.get_todos())
    finally:
        main_mod.state_mod.todos[:] = original_todos

    ids = {t["id"] for t in items}
    assert "cli-only-1" in ids
    got = next(t for t in items if t["id"] == "cli-only-1")
    assert got["title"] == "bean add this"
    assert got["completed"] is False


# ─── B4: StrictBool on agent toggle ─────────────────────────────────────────

def test_agent_toggle_rejects_string_true():
    """B4: the Settings endpoint must reject '{"enabled":"true"}' as a 422."""
    from pydantic import ValidationError
    # Import the class via main rather than reaching into its internals —
    # testing the Pydantic model directly is sufficient and avoids spinning
    # up the whole FastAPI app for a schema-only regression.
    import main as main_mod
    with pytest.raises(ValidationError):
        main_mod._AgentToggle(enabled="true")
    with pytest.raises(ValidationError):
        main_mod._AgentToggle(enabled=1)
    # The happy path still works.
    assert main_mod._AgentToggle(enabled=True).enabled is True
    assert main_mod._AgentToggle(enabled=False).enabled is False
