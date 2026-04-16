"""Multi-agent usage tracking.

Scanners for GitHub Copilot CLI, Claude Code, Codex CLI, and OpenCode parse
each agent's on-disk session data and feed a shared, idempotent writer that
persists normalized rows into ``~/.taskbean/taskbean.db``.

Design notes:
  * The CLI (``bean``) only writes ``todos.agent`` / ``todos.agent_session_id``.
    The Python backend is the sole writer for ``agent_sessions``,
    ``agent_turns``, ``agent_sources``, and ``agent_settings``.
  * Scanners are pure parsers — they receive the current cursor state and
    return new sessions/turns + updated cursors, but never touch the DB.
  * Forward-only for turns: on first detection we do a metadata-only seed
    of live sessions and pin turn cursors to current EOF / max id.
  * Scans are serialized by a process-level asyncio.Lock; each source's
    batch commits in one ``BEGIN IMMEDIATE`` transaction.
  * OpenCode's ``cost`` field is intentionally read but not persisted —
    taskbean does not track cost/pricing.
"""
