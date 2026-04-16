"""Windows desktop notifications and recurring reminder scheduler."""

from __future__ import annotations
import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

_toaster_available = False
try:
    from winotify import Notification as WiNotification, audio as winotify_audio
    _toaster_available = True
except Exception:
    pass

import app_config
import state as state_mod
import telemetry as telem

logger = logging.getLogger(__name__)

# Resolve icon path once at import time
_ICON_PATH = str(Path(__file__).parent.parent / "public" / "icons" / "taskbean-only.png")
if not os.path.isfile(_ICON_PATH):
    _ICON_PATH = ""

# Snapshot for detecting external state changes (Todo 2)
_last_seen_todos: dict[str, bool] = {}  # {id: completed}


def _get_tz() -> ZoneInfo:
    """Get configured timezone, falling back to America/Los_Angeles."""
    tz_name = app_config.get("timezone")
    try:
        return ZoneInfo(tz_name) if tz_name else ZoneInfo("America/Los_Angeles")
    except (KeyError, Exception):
        return ZoneInfo("America/Los_Angeles")


# ── Schedule helpers ──────────────────────────────────────────────────────────

def _time_to_minutes(hhmm: str) -> int:
    """Parse 'HH:MM' to minutes since midnight."""
    try:
        h, m = hhmm.split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return 0


def _is_in_time_block(block: dict) -> bool:
    """Check if the current time falls within a schedule block.

    Handles overnight ranges (e.g., 23:00–07:00) correctly.
    For overnight ranges, the early-morning portion (before end) checks
    the *previous* day's membership since the block started the night before.
    """
    if not block.get("enabled"):
        return False
    now = datetime.now(tz=_get_tz())
    days = block.get("days", [])
    day_name = now.strftime("%a").lower()[:3]
    start = _time_to_minutes(block.get("start", "00:00"))
    end = _time_to_minutes(block.get("end", "00:00"))
    current = now.hour * 60 + now.minute
    if start > end:
        # Overnight range (e.g., Mon 23:00 – Tue 07:00)
        if current >= start:
            return day_name in days  # evening side — check today
        if current < end:
            # Morning side — check yesterday (the block started last night)
            from datetime import timedelta
            yesterday = (now - timedelta(days=1)).strftime("%a").lower()[:3]
            return yesterday in days
        return False
    return day_name in days and start <= current < end


def _is_in_dnd() -> bool:
    """Check if current time is within Do Not Disturb hours."""
    return _is_in_time_block(app_config.dnd_schedule())


def _is_in_reminder_hours() -> bool:
    """Check if current time is within the active reminder window.

    Returns True if reminder hours are not configured (disabled = always OK).
    """
    hours = app_config.reminder_hours()
    if not hours.get("enabled"):
        return True  # not configured → all hours are valid
    return _is_in_time_block(hours)


# ── Notifications ─────────────────────────────────────────────────────────────

def _base_url() -> str:
    port = app_config.get("port") or 2326
    return f"http://localhost:{port}"


def send_notification(
    title: str,
    message: str,
    *,
    todo_id: str | None = None,
    tag: str | None = None,
    group: str = "taskbean",
    force: bool = False,
) -> None:
    """Fire a Windows toast notification with optional action buttons.

    Args:
        todo_id: If provided, adds Done/Snooze/Open action buttons.
        tag: Toast tag for replacement (prevents stacking).
        group: Toast group (default: "taskbean").
        force: Bypass DND schedule (for user-initiated tests).
    """
    if not force and _is_in_dnd():
        logger.info("Notification suppressed (DND): %s — %s", title, message)
        return

    telem.emit("reminder.fired", {"title": f"{title} — {message}"[:100]})

    if _toaster_available:
        try:
            base = _base_url()
            toast = WiNotification(
                app_id="taskbean",
                title=title,
                msg=message,
                duration="short",
                icon=_ICON_PATH,
                launch=base,
            )
            toast.set_audio(winotify_audio.Default, loop=False)
            if tag:
                toast.tag = tag
                toast.group = group
            if todo_id:
                toast.add_actions(label="✅ Done", launch=f"{base}/api/todos/{todo_id}?action=complete")
                toast.add_actions(label="⏰ Snooze", launch=f"{base}/api/todos/{todo_id}?action=snooze")
                toast.add_actions(label="📋 Open", launch=base)
            toast.show()
        except Exception as e:
            logger.warning("winotify notification failed: %s", e)
    else:
        logger.info("Notification (no toaster): %s — %s", title, message)


async def reminder_scheduler() -> None:
    """Background task: check reminders, recurring templates, and state changes every 30 seconds."""
    global _last_seen_todos
    # Initialize snapshot so first tick doesn't fire for pre-existing todos
    _last_seen_todos = {t["id"]: t.get("completed", False) for t in state_mod.todos}
    while True:
        await asyncio.sleep(30)
        try:
            _check_reminders()
            _check_recurring_templates()
            _check_state_changes()
        except Exception as e:
            logger.warning("Scheduler error: %s", e)


def _check_reminders() -> None:
    now_ts = datetime.now(tz=_get_tz()).timestamp() * 1000
    for todo in state_mod.todos:
        if not todo.get("reminder") or todo.get("reminderFired"):
            continue
        remind_at = todo.get("remindAt")
        if not remind_at:
            continue
        try:
            remind_ts = datetime.fromisoformat(remind_at).timestamp() * 1000
        except Exception:
            continue
        if now_ts >= remind_ts:
            todo["reminderFired"] = True
            send_notification(
                f"⏰ {todo.get('emoji', '')} Reminder".strip(),
                todo["title"],
                todo_id=todo["id"],
                tag=f"reminder-{todo['id']}",
                group="taskbean-reminders",
            )


def _check_recurring_templates() -> None:
    now_ts = datetime.now(tz=_get_tz()).timestamp() * 1000
    if not _is_in_reminder_hours():
        return
    for rec in state_mod.recurring_templates:
        if not rec.get("active"):
            continue
        last_fired = rec.get("lastFired", 0)
        interval_ms = rec.get("intervalMs", 0)
        if interval_ms and now_ts - last_fired >= interval_ms:
            rec["lastFired"] = now_ts
            send_notification(
                f"⏰ {rec['title']}",
                rec.get("description", ""),
                tag=f"recurring-{rec.get('id', rec['title'])}",
                group="taskbean-recurring",
            )


def _check_state_changes() -> None:
    """Detect todos added or completed since last tick and fire toasts."""
    global _last_seen_todos
    current = {t["id"]: t.get("completed", False) for t in state_mod.todos}

    for tid, completed in current.items():
        prev = _last_seen_todos.get(tid)
        if prev is None:
            # Newly added task
            todo = next((t for t in state_mod.todos if t["id"] == tid), None)
            if todo:
                send_notification(
                    f"📋 New task",
                    todo["title"],
                    tag=f"agent-{tid}",
                    group="taskbean-agent",
                )
        elif not prev and completed:
            # Task just completed
            todo = next((t for t in state_mod.todos if t["id"] == tid), None)
            if todo:
                send_notification(
                    f"🎉 Task completed",
                    todo["title"],
                    tag=f"agent-{tid}",
                    group="taskbean-agent",
                )

    _last_seen_todos = current
