"""Claude Code scanner.

Data layout:
  ~/.claude/projects/{encoded-cwd}/{session-uuid}.jsonl

Each JSONL file is one session. Lines have heterogeneous ``type`` but every
content line carries: ``sessionId``, ``timestamp``, ``cwd``, ``version``,
``gitBranch``. Assistant messages carry:

  {"type":"assistant","message":{"model":"claude-sonnet-...",
      "usage":{"input_tokens":N,"cache_creation_input_tokens":N,
               "cache_read_input_tokens":N,"output_tokens":N},
      "stop_reason":"end_turn"|"tool_use"|...}}

``tool_use`` turns are Claude deciding to call a tool; we count them as a
turn with ``tool_calls=len(content-blocks-of-type-tool_use)``.
"""

from __future__ import annotations

import glob
import json
import logging
import os
import time


logger = logging.getLogger(__name__)

from ..jsonl_reader import read_jsonl_incremental
from ..types import (
    AgentSource, CLAUDE_CODE, DetectionResult, ScanResult,
    SessionRow, TurnRow, canonical_cwd, iso_utc, iso_from_ms,
)


CLAUDE_HOME = os.path.join(os.path.expanduser("~"), ".claude")
CLAUDE_PROJECTS = os.path.join(CLAUDE_HOME, "projects")


class ClaudeCodeScanner:
    agent = CLAUDE_CODE

    def detect(self) -> DetectionResult:
        if not os.path.isdir(CLAUDE_PROJECTS):
            return DetectionResult(installed=False)
        # Require at least one JSONL to count as installed.
        for _ in glob.iglob(os.path.join(CLAUDE_PROJECTS, "*", "*.jsonl")):
            return DetectionResult(installed=True, detected_at=iso_utc(), data_path=CLAUDE_HOME)
        return DetectionResult(installed=True, detected_at=iso_utc(), data_path=CLAUDE_HOME)

    def _enumerate_files(self) -> list[str]:
        if not os.path.isdir(CLAUDE_PROJECTS):
            return []
        return sorted(glob.glob(os.path.join(CLAUDE_PROJECTS, "*", "*.jsonl")))

    # ── seed: metadata-only, pin cursors to EOF ──────────────────────────────

    def seed(self) -> ScanResult:
        result = ScanResult()
        now_ms = int(time.time() * 1000)
        for path in self._enumerate_files():
            meta = _scan_for_metadata(path)
            if not meta:
                continue
            try:
                st = os.stat(path)
                size = st.st_size
                mt = int(st.st_mtime * 1000)
            except OSError:
                size = 0
                mt = now_ms
            result.sessions.append(SessionRow(
                agent=self.agent,
                native_id=meta["sessionId"],
                cwd=canonical_cwd(meta.get("cwd")),
                title=None,
                model=meta.get("model"),
                provider="anthropic",
                cli_version=meta.get("version"),
                git_branch=meta.get("gitBranch"),
                source_path=path,
                started_at=meta.get("started_at") or iso_from_ms(mt),
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
                # New file: seed metadata, pin to EOF.
                meta = _scan_for_metadata(path)
                if not meta:
                    continue
                try:
                    st = os.stat(path)
                    size = st.st_size
                    mt = int(st.st_mtime * 1000)
                except OSError:
                    size, mt = 0, now_ms
                result.sessions.append(SessionRow(
                    agent=self.agent,
                    native_id=meta["sessionId"],
                    cwd=canonical_cwd(meta.get("cwd")),
                    title=None,
                    model=meta.get("model"),
                    provider="anthropic",
                    cli_version=meta.get("version"),
                    git_branch=meta.get("gitBranch"),
                    source_path=path,
                    started_at=meta.get("started_at") or iso_from_ms(mt),
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

            # Metadata (sessionId/cwd/version/...) is on every line in Claude
            # Code JSONL, but defensively fall back to the file head so we
            # never emit TurnRows with native_session_id="" (which would hit
            # the agent_turns FK to agent_sessions.id on write_scan_result).
            head_meta = _scan_for_metadata(path) or {}
            session_id = head_meta.get("sessionId")
            session_cwd = head_meta.get("cwd")
            session_model = head_meta.get("model")
            session_branch = head_meta.get("gitBranch")
            cli_version = head_meta.get("version")
            if not session_id:
                logger.warning("claude-code: no sessionId in %s, skipping scan", path)
                continue

            prior_turns = _count_assistant_turns(path, existing.last_offset)
            seq = prior_turns

            for raw in lines:
                try:
                    ev = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                # In-range metadata overrides the head-read fallback only if
                # the head read missed a field.
                if not session_cwd and ev.get("cwd"):
                    session_cwd = ev["cwd"]
                if not session_branch and ev.get("gitBranch"):
                    session_branch = ev["gitBranch"]
                if not cli_version and ev.get("version"):
                    cli_version = ev["version"]
                if ev.get("type") != "assistant":
                    continue

                msg = ev.get("message") or {}
                usage = msg.get("usage") or {}
                if not usage:
                    continue
                seq += 1
                model = msg.get("model")
                session_model = model or session_model
                # Tool uses = number of content blocks with type=tool_use.
                tool_calls = sum(
                    1 for c in (msg.get("content") or [])
                    if isinstance(c, dict) and c.get("type") == "tool_use"
                )
                inp = int(usage.get("input_tokens") or 0)
                cached = int(
                    (usage.get("cache_read_input_tokens") or 0)
                    + (usage.get("cache_creation_input_tokens") or 0)
                )
                out = int(usage.get("output_tokens") or 0)
                total = inp + cached + out
                # B7: suppress phantom rows. If Anthropic dropped a usage block
                # with every counter at zero AND no tool_use block, there's
                # nothing worth persisting — don't pollute the turns table
                # with output_tokens=0 noise that skews per-agent aggregates.
                if total == 0 and tool_calls == 0:
                    seq -= 1
                    continue
                result.turns.append(TurnRow(
                    agent=self.agent,
                    native_session_id=session_id or "",
                    seq=seq,
                    occurred_at=ev.get("timestamp") or iso_utc(),
                    model=model,
                    provider="anthropic",
                    input_tokens=inp,
                    cached_input_tokens=cached,
                    output_tokens=out,
                    reasoning_tokens=0,
                    total_tokens=total,
                    tool_calls=tool_calls,
                    finish_reason=msg.get("stop_reason"),
                ))

            # session_id is guaranteed non-empty (we'd have skipped above).
            result.sessions.append(SessionRow(
                agent=self.agent,
                native_id=session_id,
                cwd=canonical_cwd(session_cwd),
                title=None,
                model=session_model,
                provider="anthropic",
                cli_version=cli_version,
                git_branch=session_branch,
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

def _scan_for_metadata(path: str) -> dict | None:
    """Read up to ~30 lines to find sessionId, cwd, version, gitBranch, first assistant model."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            out: dict = {}
            first_ts = None
            for i, line in enumerate(f):
                if i > 60 and out.get("sessionId") and out.get("cwd"):
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if first_ts is None:
                    first_ts = ev.get("timestamp")
                for k in ("sessionId", "cwd", "version", "gitBranch"):
                    if k not in out and ev.get(k):
                        out[k] = ev[k]
                if "model" not in out and ev.get("type") == "assistant":
                    m = (ev.get("message") or {}).get("model")
                    if m:
                        out["model"] = m
            if first_ts:
                out["started_at"] = first_ts
            return out if out.get("sessionId") else None
    except OSError:
        return None


def _count_assistant_turns(path: str, up_to_offset: int) -> int:
    if up_to_offset <= 0:
        return 0
    try:
        with open(path, "rb") as f:
            chunk = f.read(up_to_offset)
    except OSError:
        return 0
    count = 0
    for raw in chunk.split(b"\n"):
        raw = raw.strip()
        if not raw:
            continue
        try:
            ev = json.loads(raw.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "assistant" and (ev.get("message") or {}).get("usage"):
            count += 1
    return count
