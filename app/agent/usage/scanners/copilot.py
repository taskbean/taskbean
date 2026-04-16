"""GitHub Copilot CLI scanner.

Data layout:
  ~/.copilot/session-store.db                      SQLite: sessions table
  ~/.copilot/session-state/{session_id}/events.jsonl  Per-session events

Each events.jsonl is one ingest source. Cursor = (offset, mtime). The sqlite
DB is used only for session metadata (cwd, summary, created_at).

Event shapes that matter:
  session.start              data.selectedModel
  session.model_change       data.newModel
  user.message               (increments turn counter)
  assistant.message          data.outputTokens
  tool.execution_start       data.toolName (increments tool_calls on current turn)
  session.task_complete      data.summary
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from typing import Iterable

from ..jsonl_reader import read_jsonl_incremental
from ..types import (
    AGENTS, COPILOT, AgentSource, DetectionResult, ScanResult, SessionRow,
    TurnRow, canonical_cwd, iso_utc, iso_from_ms,
)


COPILOT_HOME = os.path.join(os.path.expanduser("~"), ".copilot")
COPILOT_DB = os.path.join(COPILOT_HOME, "session-store.db")
COPILOT_STATE = os.path.join(COPILOT_HOME, "session-state")


class CopilotScanner:
    agent = COPILOT

    # ── detection ────────────────────────────────────────────────────────────

    def detect(self) -> DetectionResult:
        if not os.path.exists(COPILOT_DB):
            return DetectionResult(installed=False)
        return DetectionResult(
            installed=True,
            detected_at=iso_utc(),
            data_path=COPILOT_HOME,
        )

    # ── internal: list sessions ──────────────────────────────────────────────

    def _session_index(self) -> list[dict]:
        """Return [{id, cwd, summary, created_at, updated_at?}] from sqlite."""
        if not os.path.exists(COPILOT_DB):
            return []
        try:
            conn = sqlite3.connect(f"file:{COPILOT_DB}?mode=ro", uri=True, timeout=2.0)
            conn.row_factory = sqlite3.Row
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(sessions)")}
            select = "id, cwd, summary, created_at"
            if "updated_at" in cols:
                select += ", updated_at"
            rows = conn.execute(f"SELECT {select} FROM sessions").fetchall()
            conn.close()
            return [dict(r) for r in rows]
        except sqlite3.Error:
            return []

    def _events_path(self, session_id: str) -> str:
        return os.path.join(COPILOT_STATE, session_id, "events.jsonl")

    # ── public API ───────────────────────────────────────────────────────────

    def seed(self) -> ScanResult:
        """Metadata-only seed: create session rows for every current session,
        and pin each events.jsonl cursor to its current EOF."""
        result = ScanResult()
        now_ms = int(time.time() * 1000)

        for s in self._session_index():
            sid = s["id"]
            ev_path = self._events_path(sid)
            started = s.get("created_at") or iso_utc()
            updated = s.get("updated_at") or started
            # Peek at events.jsonl only for model (one cheap scan of the file
            # header is kinder than emitting rows with model=None).
            model = _peek_initial_model(ev_path)
            result.sessions.append(SessionRow(
                agent=self.agent,
                native_id=sid,
                cwd=canonical_cwd(s.get("cwd")),
                title=s.get("summary"),
                model=model,
                provider="github",
                cli_version=None,
                git_branch=None,
                source_path=ev_path,
                started_at=started,
                updated_at=updated,
            ))

            # Pin cursor to current EOF.
            try:
                st = os.stat(ev_path)
                size = st.st_size
                mtime_ms = int(st.st_mtime * 1000)
            except OSError:
                size = 0
                mtime_ms = now_ms
            result.updated_sources[ev_path] = AgentSource(
                agent=self.agent,
                source_path=ev_path,
                last_offset=size,
                last_mtime=mtime_ms,
            )

        result.last_active_at = iso_utc()
        return result

    def scan(self, sources: dict[str, AgentSource]) -> ScanResult:
        """Incremental scan. Any events.jsonl whose path is NOT in sources is
        a new session — seed its metadata and pin its cursor to EOF (no
        turn backfill). Known sources get parsed from their last offset."""
        result = ScanResult()
        now_ms = int(time.time() * 1000)
        latest_active: float = 0.0

        index = {s["id"]: s for s in self._session_index()}
        for sid, meta in index.items():
            ev_path = self._events_path(sid)
            if not os.path.exists(ev_path):
                continue

            existing = sources.get(ev_path)
            if existing is None:
                # NEW session since last scan — metadata-only seed, pin to EOF.
                model = _peek_initial_model(ev_path)
                started = meta.get("created_at") or iso_utc()
                updated = meta.get("updated_at") or started
                result.sessions.append(SessionRow(
                    agent=self.agent,
                    native_id=sid,
                    cwd=canonical_cwd(meta.get("cwd")),
                    title=meta.get("summary"),
                    model=model,
                    provider="github",
                    cli_version=None,
                    git_branch=None,
                    source_path=ev_path,
                    started_at=started,
                    updated_at=updated,
                ))
                try:
                    st = os.stat(ev_path)
                    size = st.st_size
                    mt = int(st.st_mtime * 1000)
                except OSError:
                    size = 0
                    mt = now_ms
                result.updated_sources[ev_path] = AgentSource(
                    agent=self.agent, source_path=ev_path,
                    last_offset=size, last_mtime=mt,
                )
                continue

            # Existing source — read new lines.
            lines, new_offset, new_mtime = read_jsonl_incremental(
                ev_path, existing.last_offset, existing.last_mtime,
            )
            if not lines and new_offset == existing.last_offset:
                # No progress; still bump cursor timestamp.
                continue

            # Build up turns from this batch. Seq numbering uses a starting
            # seq chosen from the existing max in DB would require a read;
            # instead we use assistant.message occurrence order and rely on
            # UNIQUE(session_id, seq) combined with the seq we compute by
            # scanning the WHOLE file only on new sessions. For incremental
            # updates, we seq = (count of prior assistant.messages) + new.
            prior_seq = _count_assistant_messages(ev_path, existing.last_offset)
            session_model: str | None = None
            session_title: str | None = meta.get("summary")
            pending_tool_calls = 0
            new_seq = prior_seq

            for raw in lines:
                try:
                    ev = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                t = ev.get("type") or ""
                data = ev.get("data") or {}
                ts = ev.get("timestamp") or ev.get("createdAt")

                if t == "session.start":
                    session_model = data.get("selectedModel") or session_model
                elif t == "session.model_change":
                    session_model = data.get("newModel") or data.get("model") or session_model
                elif t == "tool.execution_start":
                    pending_tool_calls += 1
                elif t == "assistant.message":
                    new_seq += 1
                    out_tok = int(data.get("outputTokens") or 0)
                    result.turns.append(TurnRow(
                        agent=self.agent,
                        native_session_id=sid,
                        seq=new_seq,
                        occurred_at=_to_iso(ts) or iso_utc(),
                        model=session_model,
                        provider="github",
                        input_tokens=0,  # Copilot events don't persist input tokens.
                        cached_input_tokens=0,
                        output_tokens=out_tok,
                        reasoning_tokens=0,
                        total_tokens=out_tok,
                        tool_calls=pending_tool_calls,
                        finish_reason=data.get("finishReason"),
                    ))
                    pending_tool_calls = 0
                elif t == "session.task_complete":
                    session_title = data.get("summary") or session_title

            # Emit an updated session row so title/model stay fresh.
            result.sessions.append(SessionRow(
                agent=self.agent,
                native_id=sid,
                cwd=canonical_cwd(meta.get("cwd")),
                title=session_title,
                model=session_model,
                provider="github",
                cli_version=None,
                git_branch=None,
                source_path=ev_path,
                started_at=meta.get("created_at") or iso_utc(),
                updated_at=_to_iso(None, fallback_ms=new_mtime) or iso_utc(),
            ))

            result.updated_sources[ev_path] = AgentSource(
                agent=self.agent,
                source_path=ev_path,
                last_offset=new_offset,
                last_mtime=new_mtime,
            )
            latest_active = max(latest_active, new_mtime / 1000.0)

        if latest_active:
            result.last_active_at = iso_utc(latest_active)
        return result


# ── utilities ────────────────────────────────────────────────────────────────

def _peek_initial_model(ev_path: str) -> str | None:
    """Read until first session.start event to capture initial model."""
    if not os.path.exists(ev_path):
        return None
    try:
        with open(ev_path, "r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i > 20:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if ev.get("type") == "session.start":
                    return (ev.get("data") or {}).get("selectedModel")
    except OSError:
        return None
    return None


def _count_assistant_messages(ev_path: str, up_to_offset: int) -> int:
    """Count assistant.message events in [0, up_to_offset)."""
    if up_to_offset <= 0 or not os.path.exists(ev_path):
        return 0
    count = 0
    try:
        with open(ev_path, "rb") as f:
            chunk = f.read(up_to_offset)
        for raw in chunk.split(b"\n"):
            raw = raw.strip()
            if not raw:
                continue
            try:
                ev = json.loads(raw.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "assistant.message":
                count += 1
    except OSError:
        pass
    return count


def _to_iso(ts, *, fallback_ms: int | None = None) -> str | None:
    """Accept ISO string, epoch seconds, or epoch ms; return ISO UTC."""
    if ts is None:
        if fallback_ms is None:
            return None
        return iso_from_ms(fallback_ms)
    if isinstance(ts, (int, float)):
        # If it looks like ms, divide.
        if ts > 10**12:
            return iso_from_ms(int(ts))
        return iso_utc(float(ts))
    if isinstance(ts, str):
        return ts
    return None
