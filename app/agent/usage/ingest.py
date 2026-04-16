"""Ingest pipeline: orchestrate scanners, persist via writer, serve aggregates.

Exported entry points:
  * ``run_ingest()`` — async, scans every detected+enabled agent once.
  * ``get_agent_usage(period, agents)`` — async, returns the dict consumed
    by the ``/api/agent-usage`` endpoint. Runs ingest first.
  * ``get_detection_status()`` — cheap, no ingest; used by Settings panel.

All DB mutation happens behind an asyncio.Lock so overlapping HTTP requests
serialize through a single ingest run. Heavy scanner work is offloaded to
``asyncio.to_thread`` so FastAPI's event loop stays responsive.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Iterable

from .db import (
    backfill_todo_sessions, connect, is_enabled, load_sources,
    record_detection, write_scan_result,
)
from .scanners import all_scanners
from .types import AGENTS, AgentScanner


logger = logging.getLogger(__name__)

_INGEST_LOCK = asyncio.Lock()
_LAST_INGEST_AT: float = 0.0
_MIN_INGEST_INTERVAL = 2.0  # seconds — rate-limit overlapping callers


def _run_scanner_sync(scanner: AgentScanner) -> None:
    """Synchronous body of one scanner run. Called from a thread."""
    detection = scanner.detect()
    conn = connect()
    try:
        if not detection.installed:
            return
        record_detection(conn, scanner.agent, True)
        if not is_enabled(conn, scanner.agent):
            return

        existing = load_sources(conn, scanner.agent)
        try:
            if not existing:
                result = scanner.seed()
            else:
                result = scanner.scan(existing)
        except Exception:  # pragma: no cover — scanner bugs shouldn't poison ingest
            logger.exception("scanner %s failed", scanner.agent)
            return

        if not (result.sessions or result.turns or result.updated_sources):
            return
        write_scan_result(conn, scanner.agent, result)
    finally:
        conn.close()


async def run_ingest(force: bool = False) -> None:
    """Run every scanner once. Rate-limited unless ``force``."""
    global _LAST_INGEST_AT
    now = time.monotonic()
    if not force and now - _LAST_INGEST_AT < _MIN_INGEST_INTERVAL:
        return

    async with _INGEST_LOCK:
        now = time.monotonic()
        if not force and now - _LAST_INGEST_AT < _MIN_INGEST_INTERVAL:
            return
        for scanner in all_scanners():
            await asyncio.to_thread(_run_scanner_sync, scanner)
        # After all scanners, link orphan todos to newly-ingested sessions.
        await asyncio.to_thread(_backfill_sync)
        _LAST_INGEST_AT = time.monotonic()


def _backfill_sync() -> None:
    conn = connect()
    try:
        n = backfill_todo_sessions(conn)
        if n:
            logger.info("backfilled %d todo(s) with agent_session_id", n)
    except Exception:  # pragma: no cover — backfill is best-effort
        logger.exception("backfill_todo_sessions failed")
    finally:
        conn.close()


# ── queries ──────────────────────────────────────────────────────────────────

_PERIOD_CLAUSES = {
    "today": "date(occurred_at) = date('now', 'localtime')",
    "week":  "date(occurred_at) >= date('now', '-7 days', 'localtime')",
    "month": "date(occurred_at) >= date('now', 'start of month', 'localtime')",
    "all":   "1=1",
}

_SESSION_PERIOD_CLAUSES = {
    "today": "date(started_at) = date('now', 'localtime')",
    "week":  "date(started_at) >= date('now', '-7 days', 'localtime')",
    "month": "date(started_at) >= date('now', 'start of month', 'localtime')",
    "all":   "1=1",
}


def _compute_usage_sync(period: str, agents_filter: list[str] | None) -> dict:
    p = period if period in _PERIOD_CLAUSES else "today"
    turn_clause = _PERIOD_CLAUSES[p]
    sess_clause = _SESSION_PERIOD_CLAUSES[p]

    conn = connect()
    try:
        # Detection/settings first.
        settings = {
            r["agent"]: dict(r) for r in conn.execute(
                "SELECT agent, enabled, detected_at, last_active_at FROM agent_settings"
            )
        }

        enabled_agents = [a for a in AGENTS if settings.get(a, {}).get("enabled", 1)]
        if agents_filter:
            enabled_agents = [a for a in enabled_agents if a in agents_filter]

        if not enabled_agents:
            return {
                "available": False,
                "period": p,
                "agents": [],
                "settings": settings,
                "totals": _empty_totals(),
                "byAgent": {},
                "byModel": {},
                "details": [],
            }

        placeholders = ",".join(["?"] * len(enabled_agents))

        # Per-agent totals from turns.
        turn_rows = conn.execute(
            f"""
            SELECT agent,
                   COUNT(*)                   AS turns,
                   COUNT(DISTINCT session_id) AS sessions,
                   COALESCE(SUM(input_tokens), 0)        AS input_tokens,
                   COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
                   COALESCE(SUM(output_tokens), 0)       AS output_tokens,
                   COALESCE(SUM(reasoning_tokens), 0)    AS reasoning_tokens,
                   COALESCE(SUM(total_tokens), 0)        AS total_tokens,
                   COALESCE(SUM(tool_calls), 0)          AS tool_calls
            FROM agent_turns
            WHERE agent IN ({placeholders}) AND {turn_clause}
            GROUP BY agent
            """,
            enabled_agents,
        ).fetchall()
        by_agent: dict[str, dict] = {a: _empty_totals() for a in enabled_agents}
        for r in turn_rows:
            by_agent[r["agent"]] = {
                "turns": r["turns"],
                "sessions": r["sessions"],
                "inputTokens": r["input_tokens"],
                "cachedInputTokens": r["cached_input_tokens"],
                "outputTokens": r["output_tokens"],
                "reasoningTokens": r["reasoning_tokens"],
                "totalTokens": r["total_tokens"],
                "toolCalls": r["tool_calls"],
            }

        # Also count sessions that have ZERO turns in period but were started in period.
        seed_sessions = conn.execute(
            f"""
            SELECT agent, COUNT(*) AS n FROM agent_sessions
            WHERE agent IN ({placeholders}) AND {sess_clause}
              AND id NOT IN (
                  SELECT DISTINCT session_id FROM agent_turns
                  WHERE agent IN ({placeholders}) AND {turn_clause}
              )
            GROUP BY agent
            """,
            enabled_agents + enabled_agents,
        ).fetchall()
        for r in seed_sessions:
            by_agent[r["agent"]]["sessions"] += r["n"]

        # Per-model breakdown.
        model_rows = conn.execute(
            f"""
            SELECT agent, COALESCE(model, 'unknown') AS model,
                   COUNT(DISTINCT session_id) AS sessions,
                   COALESCE(SUM(output_tokens), 0) AS output_tokens,
                   COUNT(*) AS turns
            FROM agent_turns
            WHERE agent IN ({placeholders}) AND {turn_clause}
            GROUP BY agent, COALESCE(model, 'unknown')
            ORDER BY sessions DESC
            """,
            enabled_agents,
        ).fetchall()
        by_model = [dict(r) for r in model_rows]

        # Session detail (recent first), joined with a turn-count per session.
        detail_rows = conn.execute(
            f"""
            SELECT s.id, s.agent, s.native_id, s.cwd, s.project_id, s.title,
                   s.model AS session_model, s.provider, s.cli_version,
                   s.started_at, s.updated_at,
                   COALESCE(agg.turns, 0)            AS turns,
                   COALESCE(agg.output_tokens, 0)    AS output_tokens,
                   COALESCE(agg.input_tokens, 0)     AS input_tokens,
                   COALESCE(agg.total_tokens, 0)     AS total_tokens
            FROM agent_sessions s
            LEFT JOIN (
                SELECT session_id,
                       COUNT(*) AS turns,
                       SUM(input_tokens) AS input_tokens,
                       SUM(output_tokens) AS output_tokens,
                       SUM(total_tokens) AS total_tokens
                FROM agent_turns
                WHERE {turn_clause}
                GROUP BY session_id
            ) agg ON agg.session_id = s.id
            WHERE s.agent IN ({placeholders}) AND
                  (({sess_clause}) OR date(s.updated_at) >= date('now', '-7 days', 'localtime'))
            ORDER BY s.updated_at DESC
            LIMIT 200
            """,
            enabled_agents,
        ).fetchall()
        details = [dict(r) for r in detail_rows]

        # Totals across all enabled agents.
        totals = _empty_totals()
        for a in enabled_agents:
            for k, v in by_agent[a].items():
                totals[k] += v

        return {
            "available": True,
            "period": p,
            "agents": enabled_agents,
            "settings": settings,
            "totals": totals,
            "byAgent": by_agent,
            "byModel": by_model,
            "details": details,
        }
    finally:
        conn.close()


def _empty_totals() -> dict:
    return {
        "turns": 0, "sessions": 0,
        "inputTokens": 0, "cachedInputTokens": 0,
        "outputTokens": 0, "reasoningTokens": 0,
        "totalTokens": 0, "toolCalls": 0,
    }


async def get_agent_usage(
    period: str = "today",
    agents: list[str] | None = None,
    *,
    skip_ingest: bool = False,
) -> dict:
    if not skip_ingest:
        await run_ingest()
    return await asyncio.to_thread(_compute_usage_sync, period, agents)


# ── detection (no ingest; called by Settings panel open) ─────────────────────

def _get_detection_status_sync() -> dict:
    out: dict = {}
    conn = connect()
    try:
        rows = {
            r["agent"]: dict(r) for r in conn.execute(
                "SELECT agent, enabled, detected_at, last_active_at FROM agent_settings"
            )
        }
    finally:
        conn.close()
    for scanner in all_scanners():
        d = scanner.detect()
        row = rows.get(scanner.agent, {})
        out[scanner.agent] = {
            "installed": d.installed,
            "dataPath": d.data_path,
            "enabled": bool(row.get("enabled", 1)) if d.installed else False,
            "detectedAt": row.get("detected_at"),
            "lastActiveAt": row.get("last_active_at"),
        }
    return out


async def get_detection_status() -> dict:
    # Persist detection flags (auto-enable on first sight).
    def _persist() -> None:
        conn = connect()
        try:
            for scanner in all_scanners():
                d = scanner.detect()
                if d.installed:
                    record_detection(conn, scanner.agent, True)
        finally:
            conn.close()
    await asyncio.to_thread(_persist)
    return await asyncio.to_thread(_get_detection_status_sync)


async def set_agent_enabled(agent: str, enabled: bool) -> None:
    def _write() -> None:
        from .types import iso_utc
        conn = connect()
        try:
            conn.execute(
                """
                INSERT INTO agent_settings (agent, enabled, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(agent) DO UPDATE SET
                    enabled = excluded.enabled,
                    updated_at = excluded.updated_at
                """,
                (agent, 1 if enabled else 0, iso_utc()),
            )
        finally:
            conn.close()
    await asyncio.to_thread(_write)
