"""SQLite persistence layer for todos and recurring templates.

Wraps the shared ~/.taskbean/taskbean.db so the Python backend's
in-memory state survives restarts. Uses the same DB and schema
as the CLI (cli/src/data/store.js) and the usage scanner (usage/db.py).
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timezone
from typing import Any

from usage.db import connect as _usage_connect

logger = logging.getLogger(__name__)

# Column mapping: DB snake_case <-> state.py camelCase
_TODO_DB_TO_STATE = {
    "id": "id",
    "title": "title",
    "emoji": "emoji",
    "due_date": "dueDate",
    "due_time": "dueTime",
    "completed": "completed",
    "reminder": "reminder",
    "remind_at": "remindAt",
    "reminder_fired": "reminderFired",
    "source": "source",
    "priority": "priority",
    "notes": "notes",
    "tags": "tags",
    "project": "project",
    "created_at": "createdAt",
}

_TODO_STATE_TO_DB = {v: k for k, v in _TODO_DB_TO_STATE.items()}

_TEMPLATE_DB_TO_STATE = {
    "id": "id",
    "title": "title",
    "emoji": "emoji",
    "description": "description",
    "interval_min": "intervalMin",
    "interval_ms": "intervalMs",
    "active": "active",
    "last_fired": "lastFired",
}

_TEMPLATE_STATE_TO_DB = {v: k for k, v in _TEMPLATE_DB_TO_STATE.items()}

# Bool fields stored as int 0/1 in SQLite
_TODO_BOOL_FIELDS = {"completed", "reminder", "reminderFired"}
_TEMPLATE_BOOL_FIELDS = {"active"}


def _connect() -> sqlite3.Connection:
    """Open a short-lived WAL connection to the shared taskbean DB."""
    conn = _usage_connect()
    # Ensure recurring_templates table exists
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS recurring_templates (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            emoji TEXT,
            description TEXT,
            interval_min INTEGER NOT NULL,
            interval_ms INTEGER,
            active INTEGER DEFAULT 1,
            last_fired INTEGER
        )
        """
    )
    return conn


# ── Todos ─────────────────────────────────────────────────────────────────────


def load_todos() -> list[dict[str, Any]]:
    """Load all todos from SQLite, mapped to state.py camelCase format."""
    conn = _connect()
    try:
        rows = conn.execute("SELECT * FROM todos").fetchall()
        result = []
        for row in rows:
            todo: dict[str, Any] = {}
            for db_col in _TODO_DB_TO_STATE:
                state_key = _TODO_DB_TO_STATE[db_col]
                try:
                    val = row[db_col]
                except IndexError:
                    continue
                if state_key in _TODO_BOOL_FIELDS:
                    val = bool(val)
                elif state_key == "tags":
                    try:
                        val = json.loads(val) if val else []
                    except (json.JSONDecodeError, TypeError):
                        val = []
                todo[state_key] = val
            result.append(todo)
        return result
    finally:
        conn.close()


def persist_todo(todo: dict[str, Any]) -> None:
    """INSERT OR REPLACE a todo dict into SQLite."""
    conn = _connect()
    try:
        _write_todo(conn, todo)
    finally:
        conn.close()


def update_todo_fields(todo: dict[str, Any]) -> None:
    """Persist updated todo fields (uses INSERT OR REPLACE)."""
    conn = _connect()
    try:
        _write_todo(conn, todo)
    finally:
        conn.close()


def _write_todo(conn: sqlite3.Connection, todo: dict[str, Any]) -> None:
    """Shared INSERT OR REPLACE logic for a single todo."""
    values = {}
    for state_key, db_col in _TODO_STATE_TO_DB.items():
        val = todo.get(state_key)
        if state_key in _TODO_BOOL_FIELDS:
            val = 1 if val else 0
        elif state_key == "tags":
            val = json.dumps(val) if isinstance(val, list) else val or "[]"
        values[db_col] = val

    # Ensure required fields
    if not values.get("id") or not values.get("title"):
        return
    if not values.get("created_at"):
        values["created_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    cols = list(values.keys())
    placeholders = ", ".join(["?"] * len(cols))
    col_names = ", ".join(cols)
    conn.execute(
        f"INSERT OR REPLACE INTO todos ({col_names}) VALUES ({placeholders})",
        [values[c] for c in cols],
    )


def delete_todo(todo_id: str) -> None:
    """DELETE a todo by id."""
    conn = _connect()
    try:
        conn.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
    finally:
        conn.close()


# ── Recurring templates ───────────────────────────────────────────────────────


def load_templates() -> list[dict[str, Any]]:
    """Load all recurring templates from SQLite, mapped to state.py format."""
    conn = _connect()
    try:
        rows = conn.execute("SELECT * FROM recurring_templates").fetchall()
        result = []
        for row in rows:
            template: dict[str, Any] = {}
            for db_col in _TEMPLATE_DB_TO_STATE:
                state_key = _TEMPLATE_DB_TO_STATE[db_col]
                try:
                    val = row[db_col]
                except IndexError:
                    continue
                if state_key in _TEMPLATE_BOOL_FIELDS:
                    val = bool(val)
                template[state_key] = val
            # Runtime-only defaults not in DB
            template.setdefault("icon", "repeat")
            template.setdefault("custom", False)
            result.append(template)
        return result
    finally:
        conn.close()


def persist_template(template: dict[str, Any]) -> None:
    """INSERT OR REPLACE a recurring template."""
    conn = _connect()
    try:
        _write_template(conn, template)
    finally:
        conn.close()


def update_template(template: dict[str, Any]) -> None:
    """Persist updated template (uses INSERT OR REPLACE)."""
    conn = _connect()
    try:
        _write_template(conn, template)
    finally:
        conn.close()


def _write_template(conn: sqlite3.Connection, template: dict[str, Any]) -> None:
    """Shared INSERT OR REPLACE logic for a recurring template."""
    values = {}
    for state_key, db_col in _TEMPLATE_STATE_TO_DB.items():
        val = template.get(state_key)
        if state_key in _TEMPLATE_BOOL_FIELDS:
            val = 1 if val else 0
        values[db_col] = val

    if not values.get("id") or not values.get("title"):
        return
    if values.get("interval_min") is None:
        values["interval_min"] = 30

    cols = list(values.keys())
    placeholders = ", ".join(["?"] * len(cols))
    col_names = ", ".join(cols)
    conn.execute(
        f"INSERT OR REPLACE INTO recurring_templates ({col_names}) VALUES ({placeholders})",
        [values[c] for c in cols],
    )


def delete_template(template_id: str) -> None:
    """DELETE a recurring template by id."""
    conn = _connect()
    try:
        conn.execute("DELETE FROM recurring_templates WHERE id = ?", (template_id,))
    finally:
        conn.close()
