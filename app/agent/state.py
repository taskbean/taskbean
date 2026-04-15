"""Shared in-memory state for todos and recurring templates."""

from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Any


todos: list[dict[str, Any]] = []
recurring_templates: list[dict[str, Any]] = []

BUILT_IN_TEMPLATES = [
    {"title": "Touch grass",          "icon": "trees",             "intervalMin": 120, "description": "Go outside. Feel the sun. Remember you have legs."},
    {"title": "Stand up & stretch",   "icon": "person-standing",   "intervalMin": 60,  "description": "Your spine called. It said 'please'."},
    {"title": "Drink water",          "icon": "droplets",          "intervalMin": 45,  "description": "Hydrate or diedrate. Your call."},
    {"title": "Look away from screen","icon": "eye",               "intervalMin": 20,  "description": "20-20-20 rule: 20 sec, 20 ft away, blink 20 times."},
    {"title": "Take a deep breath",   "icon": "wind",              "intervalMin": 30,  "description": "In through the nose... hold... out through the mouth. You're doing great."},
    {"title": "Check your posture",   "icon": "armchair",          "intervalMin": 40,  "description": "Shoulders back, chin up. You look like a question mark."},
    {"title": "Snack time",           "icon": "apple",             "intervalMin": 180, "description": "Fuel the machine. Preferably not just coffee."},
]


def add_todo(
    title: str,
    due_date: str | None = None,
    due_time: str | None = None,
    source: str = "manual",
    emoji: str | None = None,
    priority: str | None = None,
    notes: str | None = None,
    tags: list[str] | None = None,
    project: str | None = None,
) -> dict[str, Any]:
    todo = {
        "id": str(uuid.uuid4()),
        "title": title,
        "emoji": emoji,
        "dueDate": due_date,
        "dueTime": due_time,
        "completed": False,
        "reminder": False,
        "remindAt": None,
        "reminderFired": False,
        "source": source,
        "priority": priority if priority in ("high", "medium", "low", "none") else "none",
        "notes": (notes or "")[:5000] or None,
        "tags": list(set((tags or [])[:10])),
        "project": project,
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    todos.append(todo)
    return todo


def update_todo(todo_id: str, **fields: Any) -> dict[str, Any] | None:
    """Update specific fields on a todo. Only provided fields are changed."""
    todo = next((t for t in todos if t["id"] == todo_id), None)
    if not todo:
        return None
    allowed = {"title", "dueDate", "dueTime", "emoji", "priority", "notes", "tags",
               "completed", "reminder", "remindAt", "reminderFired", "project"}
    for key, val in fields.items():
        if key in allowed and val is not None:
            if key == "priority" and val not in ("high", "medium", "low", "none"):
                continue
            if key == "notes":
                val = None if val is None or val == "" else str(val)[:5000]
            if key == "tags":
                val = list(set(val[:10]))
            todo[key] = val
    return todo


def set_reminder(todo_id: str, remind_at: str) -> dict[str, Any] | None:
    todo = next((t for t in todos if t["id"] == todo_id), None)
    if todo:
        todo["reminder"] = True
        todo["remindAt"] = remind_at
        todo["reminderFired"] = False
    return todo


def activate_template(template: dict[str, Any]) -> dict[str, Any]:
    existing = next((r for r in recurring_templates if r["title"] == template["title"]), None)
    if existing:
        existing["active"] = True
        return existing
    rec = {
        "id": str(uuid.uuid4()),
        "title": template["title"],
        "icon": template.get("icon", "repeat"),
        "emoji": template.get("emoji"),  # backward compat
        "description": template["description"],
        "intervalMin": template["intervalMin"],
        "intervalMs": template["intervalMin"] * 60_000,
        "active": True,
        "lastFired": datetime.now(timezone.utc).timestamp() * 1000,
    }
    recurring_templates.append(rec)
    return rec


def create_custom_template(
    title: str,
    icon: str = "repeat",
    interval_min: int = 30,
    description: str = "",
) -> dict[str, Any]:
    """Create a custom recurring template."""
    # Reject titles that collide with built-in templates
    if any(t["title"] == title for t in BUILT_IN_TEMPLATES):
        raise ValueError("This name matches a built-in reminder — use the toggle to enable it instead")
    existing = next((r for r in recurring_templates if r["title"] == title), None)
    if existing:
        raise ValueError("A recurring reminder with this title already exists")
    rec = {
        "id": str(uuid.uuid4()),
        "title": title[:100],
        "icon": icon,
        "description": description[:200],
        "intervalMin": max(1, min(interval_min, 1440)),
        "intervalMs": max(1, min(interval_min, 1440)) * 60_000,
        "active": True,
        "lastFired": datetime.now(timezone.utc).timestamp() * 1000,
        "custom": True,
    }
    recurring_templates.append(rec)
    return rec


def deactivate_template(template_id: str) -> dict[str, Any] | None:
    rec = next((r for r in recurring_templates if r["id"] == template_id), None)
    if rec:
        rec["active"] = False
    return rec
