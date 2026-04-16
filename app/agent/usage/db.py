"""Writer for agent_sessions, agent_turns, agent_sources, agent_settings.

Sole writer for these tables — CLI is read-only for them (CLI only writes
``todos.agent`` and ``todos.agent_session_id``). Each source batch is wrapped
in ``BEGIN IMMEDIATE``; cursor advances only on success.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from typing import Iterable

from .types import AgentSource, ScanResult, SessionRow, TurnRow, iso_utc


def taskbean_db_path() -> str:
    home = os.environ.get("TASKBEAN_HOME") or os.path.join(os.path.expanduser("~"), ".taskbean")
    return os.environ.get("TASKBEAN_DB") or os.path.join(home, "taskbean.db")


def connect() -> sqlite3.Connection:
    path = taskbean_db_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path, timeout=5.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    ensure_schema(conn)
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Create usage tables + idempotent ALTERs on todos.

    Defends against a first-run where the Python server is started against an
    older ``~/.taskbean/taskbean.db`` that predates the usage tables (or before
    any CLI call has had a chance to run ``getDb()``). DDL is kept in lockstep
    with ``cli/src/data/store.js`` — bump both together.
    """
    # Legacy todos table (CLI is the authoritative writer; we defend against
    # first-run where the DB only has todos with no agent columns).
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS todos (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          emoji TEXT,
          due_date TEXT,
          due_time TEXT,
          completed INTEGER DEFAULT 0,
          reminder INTEGER DEFAULT 0,
          remind_at TEXT,
          reminder_fired INTEGER DEFAULT 0,
          source TEXT DEFAULT 'manual',
          priority TEXT DEFAULT 'none',
          notes TEXT,
          tags TEXT DEFAULT '[]',
          project TEXT,
          upsert_key TEXT,
          created_at TEXT NOT NULL
        )
        """
    )
    # Idempotent ALTERs — ignore "duplicate column" from repeat runs.
    for col_ddl in (
        "ALTER TABLE todos ADD COLUMN project TEXT",
        "ALTER TABLE todos ADD COLUMN upsert_key TEXT",
        "ALTER TABLE todos ADD COLUMN session_id TEXT",
        "ALTER TABLE todos ADD COLUMN agent TEXT",
        "ALTER TABLE todos ADD COLUMN agent_session_id TEXT",
        "ALTER TABLE todos ADD COLUMN project_path TEXT",
    ):
        try:
            conn.execute(col_ddl)
        except sqlite3.OperationalError:
            pass

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          tracked INTEGER DEFAULT 0,
          skill_installed INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
        """
    )

    conn.execute(
        """
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
        )
        """
    )
    for idx in (
        "CREATE INDEX IF NOT EXISTS idx_sessions_agent_started ON agent_sessions(agent, started_at)",
        "CREATE INDEX IF NOT EXISTS idx_sessions_project_started ON agent_sessions(project_id, started_at)",
        "CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON agent_sessions(cwd)",
    ):
        try:
            conn.execute(idx)
        except sqlite3.OperationalError:
            pass

    conn.execute(
        """
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
        )
        """
    )
    for idx in (
        "CREATE INDEX IF NOT EXISTS idx_turns_agent_when ON agent_turns(agent, occurred_at)",
        "CREATE INDEX IF NOT EXISTS idx_turns_model ON agent_turns(model)",
    ):
        try:
            conn.execute(idx)
        except sqlite3.OperationalError:
            pass

    # Scanner cursors. CLI calls this ``agent_sources``; keep the name stable
    # across CLI + Python so both halves can read the same rows.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_sources (
          agent TEXT NOT NULL,
          source_path TEXT NOT NULL,
          last_offset INTEGER DEFAULT 0,
          last_mtime INTEGER DEFAULT 0,
          last_native_id TEXT,
          scanned_at TEXT NOT NULL,
          PRIMARY KEY (agent, source_path)
        )
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_settings (
          agent TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 1,
          detected_at TEXT,
          last_active_at TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )


@contextmanager
def immediate_txn(conn: sqlite3.Connection):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def load_sources(conn: sqlite3.Connection, agent: str) -> dict[str, AgentSource]:
    rows = conn.execute(
        "SELECT agent, source_path, last_offset, last_mtime, last_native_id, scanned_at "
        "FROM agent_sources WHERE agent = ?",
        (agent,),
    ).fetchall()
    return {
        r["source_path"]: AgentSource(
            agent=r["agent"],
            source_path=r["source_path"],
            last_offset=r["last_offset"] or 0,
            last_mtime=r["last_mtime"] or 0,
            last_native_id=r["last_native_id"],
            scanned_at=r["scanned_at"],
        )
        for r in rows
    }


def _session_id(row: SessionRow) -> str:
    return f"{row.agent}:{row.native_id}"


def _turn_id(turn: TurnRow) -> str:
    return f"{turn.agent}:{turn.native_session_id}:{turn.seq}"


def _resolve_project_id(conn: sqlite3.Connection, cwd: str | None) -> str | None:
    """Match a session's cwd to a tracked project by longest path prefix."""
    if not cwd:
        return None
    norm = cwd.replace("\\", "/").rstrip("/").lower()
    rows = conn.execute("SELECT id, path FROM projects").fetchall()
    best: tuple[int, str] | None = None
    for r in rows:
        p = (r["path"] or "").replace("\\", "/").rstrip("/").lower()
        if not p:
            continue
        if norm == p or norm.startswith(p + "/"):
            if best is None or len(p) > best[0]:
                best = (len(p), r["id"])
    return best[1] if best else None


def write_scan_result(
    conn: sqlite3.Connection,
    agent: str,
    result: ScanResult,
) -> None:
    """Persist one scanner's output in a single IMMEDIATE txn."""
    now = iso_utc()
    with immediate_txn(conn):
        # Sessions: upsert. Don't clobber richer columns with NULL — use
        # COALESCE so a later scan with partial data doesn't wipe fields a
        # previous pass already filled in.
        for s in result.sessions:
            sid = _session_id(s)
            project_id = _resolve_project_id(conn, s.cwd)
            conn.execute(
                """
                INSERT INTO agent_sessions (
                    id, agent, native_id, cwd, project_id, title, model, provider,
                    cli_version, git_branch, source_path,
                    started_at, updated_at, ingested_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(agent, native_id) DO UPDATE SET
                    cwd         = COALESCE(excluded.cwd,         agent_sessions.cwd),
                    project_id  = COALESCE(excluded.project_id,  agent_sessions.project_id),
                    title       = COALESCE(excluded.title,       agent_sessions.title),
                    model       = COALESCE(excluded.model,       agent_sessions.model),
                    provider    = COALESCE(excluded.provider,    agent_sessions.provider),
                    cli_version = COALESCE(excluded.cli_version, agent_sessions.cli_version),
                    git_branch  = COALESCE(excluded.git_branch,  agent_sessions.git_branch),
                    updated_at  = MAX(excluded.updated_at, agent_sessions.updated_at),
                    ingested_at = excluded.ingested_at
                """,
                (
                    sid, s.agent, s.native_id, s.cwd, project_id, s.title, s.model,
                    s.provider, s.cli_version, s.git_branch, s.source_path,
                    s.started_at, s.updated_at, now,
                ),
            )

        # Turns: insert-or-ignore keyed by (session_id, seq).
        for t in result.turns:
            sid = f"{t.agent}:{t.native_session_id}"
            conn.execute(
                """
                INSERT OR IGNORE INTO agent_turns (
                    id, session_id, agent, seq, occurred_at, model, provider,
                    input_tokens, cached_input_tokens, output_tokens,
                    reasoning_tokens, total_tokens, tool_calls, finish_reason
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    _turn_id(t), sid, t.agent, t.seq, t.occurred_at,
                    t.model, t.provider, t.input_tokens, t.cached_input_tokens,
                    t.output_tokens, t.reasoning_tokens, t.total_tokens,
                    t.tool_calls, t.finish_reason,
                ),
            )

        # Cursor rows advance only after writes above succeeded.
        for src in result.updated_sources.values():
            conn.execute(
                """
                INSERT INTO agent_sources (
                    agent, source_path, last_offset, last_mtime, last_native_id, scanned_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(agent, source_path) DO UPDATE SET
                    last_offset    = excluded.last_offset,
                    last_mtime     = excluded.last_mtime,
                    last_native_id = excluded.last_native_id,
                    scanned_at     = excluded.scanned_at
                """,
                (
                    src.agent, src.source_path, src.last_offset, src.last_mtime,
                    src.last_native_id, now,
                ),
            )

        # Per-agent settings: mark active if the scan produced rows.
        if result.last_active_at or result.sessions or result.turns:
            conn.execute(
                """
                INSERT INTO agent_settings (agent, enabled, detected_at, last_active_at, updated_at)
                VALUES (?, 1, COALESCE((SELECT detected_at FROM agent_settings WHERE agent=?), ?), ?, ?)
                ON CONFLICT(agent) DO UPDATE SET
                    last_active_at = COALESCE(excluded.last_active_at, agent_settings.last_active_at),
                    updated_at = excluded.updated_at
                """,
                (agent, agent, now, result.last_active_at or now, now),
            )


def record_detection(conn: sqlite3.Connection, agent: str, installed: bool) -> None:
    """Mark agent as detected. Auto-enables on first sight; respects existing toggle otherwise."""
    now = iso_utc()
    if not installed:
        return
    with immediate_txn(conn):
        conn.execute(
            """
            INSERT INTO agent_settings (agent, enabled, detected_at, last_active_at, updated_at)
            VALUES (?, 1, ?, NULL, ?)
            ON CONFLICT(agent) DO UPDATE SET
                detected_at = COALESCE(agent_settings.detected_at, excluded.detected_at),
                updated_at = excluded.updated_at
            """,
            (agent, now, now),
        )


def is_enabled(conn: sqlite3.Connection, agent: str) -> bool:
    row = conn.execute(
        "SELECT enabled FROM agent_settings WHERE agent = ?", (agent,)
    ).fetchone()
    if row is None:
        return True  # detection will auto-enable; default is on
    return bool(row["enabled"])


def backfill_todo_sessions(conn: sqlite3.Connection) -> int:
    """Link todos.agent_session_id to newly-discovered agent_sessions.

    `bean add` runs at the start of an agent session, before that session
    has been scanned, so its agent_session_id is often NULL even though the
    agent column is populated. After a scanner ingest we revisit those
    todos and match them to a session by (agent, project, time-window):

      * todos.agent == agent_sessions.agent
      * project match:
          - if ``todos.project_path`` is populated → case-insensitive
            exact match on ``projects.path`` (Windows-safe).
          - else fall back to ``projects.name = todos.project`` BUT
            require exactly one candidate project. Ambiguous names are
            skipped rather than guessed.
      * todos.created_at falls within ``[started_at - 30m, updated_at + 30m]``.

    When multiple sessions match the same todo in the window, we only
    backfill if the closest session is more than 2× closer than the runner-up
    — otherwise we skip to avoid a coin-flip.
    """
    # B5: short-circuit when nothing is orphaned. Saves the CTE on a
    # steady-state DB where every todo already has agent_session_id set.
    orphan_count = conn.execute(
        """
        SELECT COUNT(*) FROM todos
         WHERE agent IS NOT NULL
           AND agent_session_id IS NULL
           AND project IS NOT NULL
        """
    ).fetchone()[0]
    if not orphan_count:
        return 0

    # Pull orphans once with the fields we need for Python-side resolution.
    orphans = conn.execute(
        """
        SELECT id, agent, project, project_path, created_at
          FROM todos
         WHERE agent IS NOT NULL
           AND agent_session_id IS NULL
           AND project IS NOT NULL
        """
    ).fetchall()

    updates: list[tuple[str, str]] = []  # (session_id, todo_id)
    for t in orphans:
        project_id = _resolve_project_for_backfill(
            conn, t["project_path"], t["project"]
        )
        if not project_id:
            continue
        session_id = _pick_session_for_todo(
            conn, t["agent"], project_id, t["created_at"]
        )
        if session_id:
            updates.append((session_id, t["id"]))

    if not updates:
        return 0

    with immediate_txn(conn):
        for session_id, todo_id in updates:
            conn.execute(
                "UPDATE todos SET agent_session_id = ? WHERE id = ? AND agent_session_id IS NULL",
                (session_id, todo_id),
            )
    return len(updates)


def _resolve_project_for_backfill(
    conn: sqlite3.Connection,
    project_path: str | None,
    project_name: str | None,
) -> str | None:
    """Prefer path-based match (unique, Windows-safe). Fall back to unique name."""
    if project_path:
        row = conn.execute(
            "SELECT id FROM projects WHERE LOWER(path) = LOWER(?)",
            (project_path,),
        ).fetchone()
        if row:
            return row["id"]
        # path recorded but not in projects table — don't guess by name.
        return None

    if not project_name:
        return None
    rows = conn.execute(
        "SELECT id FROM projects WHERE name = ?", (project_name,)
    ).fetchall()
    if len(rows) == 1:
        return rows[0]["id"]
    # Zero or ambiguous → skip.
    return None


def _pick_session_for_todo(
    conn: sqlite3.Connection,
    agent: str,
    project_id: str,
    created_at: str,
) -> str | None:
    """Return session id iff unambiguous within ±30min, else None.

    Tie-break rule: closest-by-started_at wins only when it's at least 2×
    closer than the runner-up. Otherwise skip — correctness > coverage.
    """
    rows = conn.execute(
        """
        SELECT id,
               ABS(julianday(?) - julianday(started_at)) AS delta
          FROM agent_sessions
         WHERE agent = ?
           AND project_id = ?
           AND julianday(?) BETWEEN
               julianday(started_at) - (30.0 / 1440.0)
           AND julianday(updated_at) + (30.0 / 1440.0)
         ORDER BY delta ASC
         LIMIT 2
        """,
        (created_at, agent, project_id, created_at),
    ).fetchall()
    if not rows:
        return None
    if len(rows) == 1:
        return rows[0]["id"]

    best, runner_up = rows[0], rows[1]
    # Both zero delta → ambiguous.
    if best["delta"] <= 0 and runner_up["delta"] <= 0:
        return None
    # Runner-up must be at least 2× as far as the winner. If the winner is
    # at delta=0 we treat it as a clear win (runner-up >0 is infinitely
    # further).
    if best["delta"] == 0:
        return best["id"] if runner_up["delta"] > 0 else None
    if runner_up["delta"] < 2.0 * best["delta"]:
        return None
    return best["id"]
