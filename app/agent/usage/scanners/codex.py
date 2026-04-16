"""Codex CLI scanner.

Data layout:
  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl

Each file is one Codex rollout/session. First line is ``session_meta`` with
id, cwd, cli_version, model_provider. Per-turn token counts come from
``event_msg`` events with ``payload.type == "token_count"`` — we use the
``info.last_token_usage`` delta to avoid double-counting the cumulative
``total_token_usage`` total.

Turn boundaries are ``event_msg`` events with ``payload.type == "task_started"``
(each task is one turn); token_count events for that turn land after.
"""

from __future__ import annotations

import glob
import json
import os
import time

from ..jsonl_reader import read_jsonl_incremental
from ..types import (
    AgentSource, CODEX, DetectionResult, ScanResult,
    SessionRow, TurnRow, canonical_cwd, iso_utc, iso_from_ms,
)


CODEX_HOME = os.path.join(os.path.expanduser("~"), ".codex")
CODEX_SESSIONS = os.path.join(CODEX_HOME, "sessions")


class CodexScanner:
    agent = CODEX

    def detect(self) -> DetectionResult:
        if not os.path.isdir(CODEX_SESSIONS):
            return DetectionResult(installed=False)
        return DetectionResult(installed=True, detected_at=iso_utc(), data_path=CODEX_HOME)

    def _enumerate_files(self) -> list[str]:
        if not os.path.isdir(CODEX_SESSIONS):
            return []
        # Depth 3: YYYY/MM/DD/rollout-*.jsonl
        return sorted(glob.glob(os.path.join(CODEX_SESSIONS, "*", "*", "*", "rollout-*.jsonl")))

    def seed(self) -> ScanResult:
        result = ScanResult()
        now_ms = int(time.time() * 1000)
        for path in self._enumerate_files():
            meta = _read_session_meta(path)
            if not meta:
                continue
            try:
                st = os.stat(path)
                size, mt = st.st_size, int(st.st_mtime * 1000)
            except OSError:
                size, mt = 0, now_ms
            result.sessions.append(SessionRow(
                agent=self.agent,
                native_id=meta["id"],
                cwd=canonical_cwd(meta.get("cwd")),
                title=None,
                model=meta.get("model"),
                provider=meta.get("model_provider") or "openai",
                cli_version=meta.get("cli_version"),
                git_branch=None,
                source_path=path,
                started_at=meta.get("timestamp") or iso_from_ms(mt),
                updated_at=iso_from_ms(mt),
            ))
            result.updated_sources[path] = AgentSource(
                agent=self.agent, source_path=path,
                last_offset=size, last_mtime=mt,
            )
        result.last_active_at = iso_utc()
        return result

    def scan(self, sources: dict[str, AgentSource]) -> ScanResult:
        result = ScanResult()
        now_ms = int(time.time() * 1000)
        latest_active = 0.0

        for path in self._enumerate_files():
            existing = sources.get(path)

            if existing is None:
                meta = _read_session_meta(path)
                if not meta:
                    continue
                try:
                    st = os.stat(path)
                    size, mt = st.st_size, int(st.st_mtime * 1000)
                except OSError:
                    size, mt = 0, now_ms
                result.sessions.append(SessionRow(
                    agent=self.agent,
                    native_id=meta["id"],
                    cwd=canonical_cwd(meta.get("cwd")),
                    title=None,
                    model=meta.get("model"),
                    provider=meta.get("model_provider") or "openai",
                    cli_version=meta.get("cli_version"),
                    git_branch=None,
                    source_path=path,
                    started_at=meta.get("timestamp") or iso_from_ms(mt),
                    updated_at=iso_from_ms(mt),
                ))
                result.updated_sources[path] = AgentSource(
                    agent=self.agent, source_path=path,
                    last_offset=size, last_mtime=mt,
                )
                continue

            lines, new_offset, new_mtime = read_jsonl_incremental(
                path, existing.last_offset, existing.last_mtime,
            )
            if not lines:
                continue

            prior_turns = _count_prior_turns(path, existing.last_offset)
            seq = prior_turns
            session_id = None
            session_model = None
            pending_tool_calls = 0

            for raw in lines:
                try:
                    ev = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                if ev.get("type") == "session_meta":
                    p = ev.get("payload") or {}
                    session_id = session_id or p.get("id")
                    session_model = session_model or p.get("model")
                    continue

                if ev.get("type") != "event_msg":
                    continue
                payload = ev.get("payload") or {}
                ptype = payload.get("type")

                if ptype == "tool_call" or ptype == "exec_command_begin" or ptype == "apply_patch_begin":
                    pending_tool_calls += 1
                    continue

                if ptype != "token_count":
                    continue
                info = payload.get("info") or {}
                last = info.get("last_token_usage") or {}
                if not last:
                    continue
                seq += 1
                inp = int(last.get("input_tokens") or 0)
                cached = int(last.get("cached_input_tokens") or 0)
                out = int(last.get("output_tokens") or 0)
                reasoning = int(last.get("reasoning_output_tokens") or 0)
                total = int(last.get("total_tokens") or (inp + out + reasoning))
                # B7: skip zero-usage rows with no tool activity. Codex
                # occasionally emits token_count events with an all-zero
                # last_token_usage (e.g. a heartbeat) — recording them as
                # real turns inflates the turn count and dilutes per-model
                # averages. If we had no tool calls either, drop the row.
                if total == 0 and inp == 0 and out == 0 and reasoning == 0 and pending_tool_calls == 0:
                    seq -= 1
                    continue
                result.turns.append(TurnRow(
                    agent=self.agent,
                    native_session_id=session_id or "",
                    seq=seq,
                    occurred_at=ev.get("timestamp") or iso_utc(),
                    model=session_model,
                    provider="openai",
                    input_tokens=inp,
                    cached_input_tokens=cached,
                    output_tokens=out,
                    reasoning_tokens=reasoning,
                    total_tokens=total,
                    tool_calls=pending_tool_calls,
                    finish_reason=None,
                ))
                pending_tool_calls = 0

            if session_id:
                result.sessions.append(SessionRow(
                    agent=self.agent,
                    native_id=session_id,
                    cwd=None,
                    title=None,
                    model=session_model,
                    provider="openai",
                    cli_version=None,
                    git_branch=None,
                    source_path=path,
                    started_at=iso_from_ms(existing.last_mtime or new_mtime),
                    updated_at=iso_from_ms(new_mtime),
                ))

            result.updated_sources[path] = AgentSource(
                agent=self.agent, source_path=path,
                last_offset=new_offset, last_mtime=new_mtime,
            )
            latest_active = max(latest_active, new_mtime / 1000.0)

        if latest_active:
            result.last_active_at = iso_utc(latest_active)
        return result


# ── utilities ────────────────────────────────────────────────────────────────

def _read_session_meta(path: str) -> dict | None:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i > 5:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if ev.get("type") == "session_meta":
                    p = dict(ev.get("payload") or {})
                    # Attach the top-level timestamp for started_at fallback.
                    if ev.get("timestamp"):
                        p.setdefault("timestamp", ev["timestamp"])
                    return p
    except OSError:
        return None
    return None


def _count_prior_turns(path: str, up_to_offset: int) -> int:
    if up_to_offset <= 0:
        return 0
    try:
        with open(path, "rb") as f:
            chunk = f.read(up_to_offset)
    except OSError:
        return 0
    n = 0
    for raw in chunk.split(b"\n"):
        raw = raw.strip()
        if not raw:
            continue
        try:
            ev = json.loads(raw.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            continue
        if ev.get("type") != "event_msg":
            continue
        p = ev.get("payload") or {}
        if p.get("type") == "token_count" and (p.get("info") or {}).get("last_token_usage"):
            n += 1
    return n
