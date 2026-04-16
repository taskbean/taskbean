"""OpenCode scanner.

Data layout:
  ~/.local/share/opencode/opencode.db   (Drizzle SQLite)

We treat the whole DB as one logical source:
  source_path = "sqlite:<absolute-path>"
Cursor uses ``last_mtime = MAX(message.time_updated)`` seen so far (ms epoch).

session: id, project_id, directory, title, version, time_created, time_updated
message: id, session_id, time_created, time_updated, data (JSON)

message.data for assistant messages has:
  {"role":"assistant","modelID":...,"providerID":...,
   "tokens":{"input":N,"output":N,"reasoning":N,"cache":{"read":N,"write":N}},
   "cost":0,   <- intentionally NOT persisted (taskbean policy)
   "finish":"tool-calls"|"stop"|...,"time":{"created":ms,"completed":ms}}
"""

from __future__ import annotations

import json
import os
import sqlite3
import time

from ..types import (
    AgentSource, OPENCODE, DetectionResult, ScanResult,
    SessionRow, TurnRow, canonical_cwd, iso_utc, iso_from_ms,
)


def _db_candidates() -> list[str]:
    home = os.path.expanduser("~")
    return [
        os.path.join(home, ".local", "share", "opencode", "opencode.db"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "opencode", "opencode.db"),
    ]


def _find_db() -> str | None:
    for p in _db_candidates():
        if p and os.path.exists(p):
            return p
    return None


class OpenCodeScanner:
    agent = OPENCODE

    def detect(self) -> DetectionResult:
        p = _find_db()
        if not p:
            return DetectionResult(installed=False)
        return DetectionResult(installed=True, detected_at=iso_utc(), data_path=p)

    def _source_path(self) -> str | None:
        p = _find_db()
        return f"sqlite:{p}" if p else None

    def _open(self) -> sqlite3.Connection | None:
        p = _find_db()
        if not p:
            return None
        try:
            # Forward-slash URI — Windows safe.
            uri = p.replace("\\", "/")
            conn = sqlite3.connect(f"file:{uri}?mode=ro", uri=True, timeout=2.0)
            conn.row_factory = sqlite3.Row
            return conn
        except sqlite3.Error:
            return None

    def seed(self) -> ScanResult:
        result = ScanResult()
        src = self._source_path()
        if not src:
            return result
        conn = self._open()
        if not conn:
            return result
        try:
            rows = conn.execute(
                "SELECT id, directory, title, version, time_created, time_updated FROM session"
            ).fetchall()
            max_t = 0
            for r in rows:
                tc = int(r["time_created"] or 0)
                tu = int(r["time_updated"] or 0)
                max_t = max(max_t, tu)
                result.sessions.append(SessionRow(
                    agent=self.agent,
                    native_id=r["id"],
                    cwd=canonical_cwd(r["directory"]),
                    title=r["title"],
                    model=None,
                    provider=None,
                    cli_version=r["version"],
                    git_branch=None,
                    source_path=src,
                    started_at=iso_from_ms(tc) if tc else iso_utc(),
                    updated_at=iso_from_ms(tu) if tu else iso_utc(),
                ))
            result.updated_sources[src] = AgentSource(
                agent=self.agent, source_path=src,
                last_offset=0, last_mtime=max_t,
            )
            result.last_active_at = iso_from_ms(max_t) if max_t else iso_utc()
        finally:
            conn.close()
        return result

    def scan(self, sources: dict[str, AgentSource]) -> ScanResult:
        result = ScanResult()
        src = self._source_path()
        if not src:
            return result

        existing = sources.get(src)
        if existing is None:
            # Seed on first contact.
            return self.seed()

        conn = self._open()
        if not conn:
            return result
        try:
            cursor_ms = int(existing.last_mtime or 0)

            # Fetch NEW messages strictly after cursor (order for stable seq).
            msgs = conn.execute(
                "SELECT id, session_id, time_created, time_updated, data "
                "FROM message WHERE time_updated > ? ORDER BY time_updated, id",
                (cursor_ms,),
            ).fetchall()

            if not msgs:
                # Nothing new, but bump scanned_at.
                result.updated_sources[src] = AgentSource(
                    agent=self.agent, source_path=src,
                    last_offset=0, last_mtime=cursor_ms,
                )
                return result

            # Collect the per-session prior-turn counts we'll need.
            session_ids = {m["session_id"] for m in msgs}
            prior_counts: dict[str, int] = {}
            for sid in session_ids:
                n = conn.execute(
                    "SELECT COUNT(*) FROM message "
                    "WHERE session_id = ? AND time_updated <= ? "
                    "AND data LIKE '%\"role\":\"assistant\"%'",
                    (sid, cursor_ms),
                ).fetchone()[0]
                prior_counts[sid] = int(n or 0)

            # Per-session metadata (always fetch for sessions touched).
            session_rows = {
                r["id"]: r for r in conn.execute(
                    "SELECT id, directory, title, version, time_created, time_updated "
                    "FROM session WHERE id IN (%s)" % ",".join(["?"] * len(session_ids)),
                    tuple(session_ids),
                ).fetchall()
            }

            max_t = cursor_ms
            for m in msgs:
                tu = int(m["time_updated"] or 0)
                max_t = max(max_t, tu)
                try:
                    data = json.loads(m["data"] or "{}")
                except json.JSONDecodeError:
                    continue
                if data.get("role") != "assistant":
                    continue

                sid = m["session_id"]
                prior_counts[sid] = prior_counts.get(sid, 0) + 1
                seq = prior_counts[sid]
                tokens = data.get("tokens") or {}
                cache = tokens.get("cache") or {}
                inp = int(tokens.get("input") or 0)
                cached = int((cache.get("read") or 0) + (cache.get("write") or 0))
                out = int(tokens.get("output") or 0)
                reasoning = int(tokens.get("reasoning") or 0)
                total = int(tokens.get("total") or (inp + out + reasoning))
                time_info = data.get("time") or {}
                occurred_ms = int(time_info.get("completed") or time_info.get("created") or tu)

                # Tool calls on this turn = count of "tool" parts for this message.
                try:
                    tool_parts = conn.execute(
                        "SELECT COUNT(*) FROM part WHERE message_id = ? "
                        "AND data LIKE '%\"type\":\"tool%'",
                        (m["id"],),
                    ).fetchone()[0]
                except sqlite3.Error:
                    tool_parts = 0

                result.turns.append(TurnRow(
                    agent=self.agent,
                    native_session_id=sid,
                    seq=seq,
                    occurred_at=iso_from_ms(occurred_ms),
                    model=data.get("modelID"),
                    provider=data.get("providerID"),
                    input_tokens=inp,
                    cached_input_tokens=cached,
                    output_tokens=out,
                    reasoning_tokens=reasoning,
                    total_tokens=total,
                    tool_calls=int(tool_parts or 0),
                    finish_reason=data.get("finish"),
                ))

                sr = session_rows.get(sid)
                if sr is not None:
                    # Emit a session row so model/provider/title stay fresh.
                    result.sessions.append(SessionRow(
                        agent=self.agent,
                        native_id=sid,
                        cwd=canonical_cwd(sr["directory"]),
                        title=sr["title"],
                        model=data.get("modelID"),
                        provider=data.get("providerID"),
                        cli_version=sr["version"],
                        git_branch=None,
                        source_path=src,
                        started_at=iso_from_ms(int(sr["time_created"] or 0))
                            if sr["time_created"] else iso_utc(),
                        updated_at=iso_from_ms(int(sr["time_updated"] or 0))
                            if sr["time_updated"] else iso_utc(),
                    ))

            result.updated_sources[src] = AgentSource(
                agent=self.agent, source_path=src,
                last_offset=0, last_mtime=max_t,
            )
            if max_t:
                result.last_active_at = iso_from_ms(max_t)
        finally:
            conn.close()
        return result
