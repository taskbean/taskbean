"""Agent Framework tool definitions — mirrors NL_TOOLS from server.js."""

from __future__ import annotations
import asyncio
import json
import sys
import time
from datetime import datetime
from typing import Annotated
from zoneinfo import ZoneInfo

import httpx
from agent_framework import tool

import app_config
import state as state_mod
import telemetry as telem


def _get_tz() -> ZoneInfo:
    """Get configured timezone, falling back to America/Los_Angeles."""
    tz_name = app_config.get("timezone")
    try:
        return ZoneInfo(tz_name) if tz_name else ZoneInfo("America/Los_Angeles")
    except (KeyError, Exception):
        return ZoneInfo("America/Los_Angeles")

# Windows strftime uses %#d to remove leading zeros; POSIX uses %-d.
_DAY_FMT = "%#d" if sys.platform == "win32" else "%-d"


def _traced_tool(fn):
    """Wrap a plain tool function to emit telemetry on each invocation.

    Apply BEFORE the @tool decorator so agent_framework sees a normal
    function with the correct signature preserved by functools.wraps.
    """
    import functools
    if asyncio.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def async_wrapper(*args, **kwargs):
            _name = fn.__name__
            _start = time.time()
            try:
                result = await fn(*args, **kwargs)
                _elapsed = int((time.time() - _start) * 1000)
                telem.emit("tool.executed", {
                    "tool": _name,
                    "args": {k: str(v)[:100] for k, v in kwargs.items()} if kwargs else {},
                    "durationMs": _elapsed,
                    "success": True,
                    "resultPreview": str(result)[:150] if result else "",
                })
                return result
            except Exception as e:
                _elapsed = int((time.time() - _start) * 1000)
                telem.emit("tool.executed", {
                    "tool": _name,
                    "args": {k: str(v)[:100] for k, v in kwargs.items()} if kwargs else {},
                    "durationMs": _elapsed,
                    "success": False,
                    "error": str(e)[:150],
                })
                raise
        return async_wrapper
    else:
        @functools.wraps(fn)
        def sync_wrapper(*args, **kwargs):
            _name = fn.__name__
            _start = time.time()
            try:
                result = fn(*args, **kwargs)
                _elapsed = int((time.time() - _start) * 1000)
                telem.emit("tool.executed", {
                    "tool": _name,
                    "args": {k: str(v)[:100] for k, v in kwargs.items()} if kwargs else {},
                    "durationMs": _elapsed,
                    "success": True,
                    "resultPreview": str(result)[:150] if result else "",
                })
                return result
            except Exception as e:
                _elapsed = int((time.time() - _start) * 1000)
                telem.emit("tool.executed", {
                    "tool": _name,
                    "args": {k: str(v)[:100] for k, v in kwargs.items()} if kwargs else {},
                    "durationMs": _elapsed,
                    "success": False,
                    "error": str(e)[:150],
                })
                raise
        return sync_wrapper


@tool
@_traced_tool
def add_task(
    title: Annotated[str, "Task title"],
    due_date: Annotated[str | None, "YYYY-MM-DD if known"] = None,
    due_time: Annotated[str | None, "HH:MM if known"] = None,
    emoji: Annotated[str | None, "A fun emoji"] = None,
    priority: Annotated[str | None, "Priority: high, medium, low, or none"] = None,
    notes: Annotated[str | None, "Optional notes in markdown format"] = None,
    tags: Annotated[list[str] | None, "Category tags like work, personal, errands"] = None,
    project: Annotated[str | None, "Project name to associate this task with"] = None,
) -> str:
    """Add a plain task or todo item (no timed reminder). Use whenever the user wants to add, create, or save something to their list."""
    todo = state_mod.add_todo(title, due_date, due_time, "command", emoji, priority, notes, tags, project)
    return json.dumps({"success": True, "todo": todo})


@tool
@_traced_tool
def set_reminder(
    title: Annotated[str, "Reminder text"],
    remind_at: Annotated[str, 'ISO 8601 datetime with timezone offset, e.g. "2026-04-09T17:00:00-07:00"'],
    due_date: Annotated[str | None, "YYYY-MM-DD"] = None,
    due_time: Annotated[str | None, "HH:MM (24h)"] = None,
    emoji: Annotated[str | None, "A fun emoji for the reminder"] = None,
) -> str:
    """Create a task with a timed notification. Use for 'remind me to...' requests."""
    todo = state_mod.add_todo(title, due_date, due_time, "reminder", emoji or "🔔")
    state_mod.set_reminder(todo["id"], remind_at)
    return json.dumps({"success": True, "todo": todo, "message": f"Reminder set for {remind_at}"})


@tool
@_traced_tool
def mark_complete(todo_id: Annotated[str, "Todo ID"]) -> str:
    """Mark a todo as done."""
    t = next((t for t in state_mod.todos if t["id"] == todo_id), None)
    if t:
        t["completed"] = True
        return json.dumps({"success": True, "todo": t})
    return json.dumps({"success": False, "error": "Not found"})


@tool
@_traced_tool
def mark_incomplete(todo_id: Annotated[str, "Todo ID"]) -> str:
    """Re-open a completed todo."""
    t = next((t for t in state_mod.todos if t["id"] == todo_id), None)
    if t:
        t["completed"] = False
        return json.dumps({"success": True, "todo": t})
    return json.dumps({"success": False, "error": "Not found"})


@tool
@_traced_tool
def remove_task(todo_id: Annotated[str, "Todo ID"]) -> str:
    """Delete a todo."""
    idx = next((i for i, t in enumerate(state_mod.todos) if t["id"] == todo_id), None)
    if idx is not None:
        removed = state_mod.todos.pop(idx)
        return json.dumps({"success": True, "removed": removed})
    return json.dumps({"success": False, "error": "Not found"})


@tool
@_traced_tool
def update_task(
    todo_id: Annotated[str, "Todo ID to update"],
    title: Annotated[str | None, "New title"] = None,
    due_date: Annotated[str | None, "New due date (YYYY-MM-DD), or 'clear' to remove"] = None,
    due_time: Annotated[str | None, "New due time (HH:MM 24h), or 'clear' to remove"] = None,
    priority: Annotated[str | None, "New priority: high, medium, low, or none"] = None,
    notes: Annotated[str | None, "Notes in markdown format, or 'clear' to remove"] = None,
    tags: Annotated[list[str] | None, "Replace tags with this list"] = None,
    emoji: Annotated[str | None, "New emoji"] = None,
) -> str:
    """Update an existing todo's fields. Only provided fields are changed. Use for 'change', 'rename', 'move', 'reschedule', or 'update' requests."""
    fields = {}
    if title is not None:
        fields["title"] = title
    if due_date is not None:
        fields["dueDate"] = None if due_date == "clear" else due_date
    if due_time is not None:
        fields["dueTime"] = None if due_time == "clear" else due_time
    if priority is not None:
        fields["priority"] = priority
    if notes is not None:
        fields["notes"] = None if notes == "clear" else notes
    if tags is not None:
        fields["tags"] = tags
    if emoji is not None:
        fields["emoji"] = emoji
    todo = state_mod.update_todo(todo_id, **fields)
    if todo:
        return json.dumps({"success": True, "todo": todo})
    return json.dumps({"success": False, "error": "Not found"})


@tool
@_traced_tool
def get_current_datetime() -> str:
    """Get current date/time in the user's configured timezone. Call when you need to resolve relative times before setting a reminder."""
    now = datetime.now(tz=_get_tz())
    return json.dumps({
        "formatted": now.strftime(f"%A, %B {_DAY_FMT}, %Y at %I:%M %p"),
        "iso": now.isoformat(),
        "timezone": app_config.get("timezone") or "America/Los_Angeles",
    })


@tool
@_traced_tool
async def get_weather(
    latitude: Annotated[float, "Latitude (default 47.674 for Redmond)"] = 47.674,
    longitude: Annotated[float, "Longitude (default -122.121 for Redmond)"] = -122.121,
) -> str:
    """Get current weather for a location. Default is Redmond, WA. Only call when the user explicitly asks about current weather conditions."""
    tz_encoded = "America%2FLos_Angeles"
    url = (
        f"https://api.open-meteo.com/v1/forecast"
        f"?latitude={latitude}&longitude={longitude}"
        f"&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,precipitation"
        f"&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone={tz_encoded}"
    )
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(url)
            r.raise_for_status()
            data = r.json()
        c = data["current"]
        codes = {
            0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
            45: "Foggy", 48: "Freezing fog", 51: "Light drizzle", 53: "Drizzle",
            55: "Dense drizzle", 61: "Slight rain", 63: "Rain", 65: "Heavy rain",
            71: "Light snow", 73: "Snow", 75: "Heavy snow", 80: "Rain showers",
            81: "Moderate showers", 82: "Heavy showers", 95: "Thunderstorm",
        }
        rainy = {51, 53, 55, 61, 63, 65, 80, 81, 82, 95}
        code = c["weather_code"]
        return json.dumps({
            "temperature": f"{c['temperature_2m']}°F",
            "feelsLike": f"{c['apparent_temperature']}°F",
            "condition": codes.get(code, f"Code {code}"),
            "humidity": f"{c['relative_humidity_2m']}%",
            "wind": f"{c['wind_speed_10m']} mph",
            "precipitation": f"{c['precipitation']} mm",
            "jacketAdvice": "Yes, bring a jacket!" if c["apparent_temperature"] < 55 or c["precipitation"] > 0 or code in rainy else "Nah, you're good without a jacket.",
            "umbrellaAdvice": "Grab an umbrella!" if code in rainy else "No umbrella needed.",
        })
    except Exception as e:
        return json.dumps({"error": str(e)})


ALL_TOOLS = [add_task, set_reminder, mark_complete, mark_incomplete, remove_task, update_task, get_current_datetime, get_weather]
