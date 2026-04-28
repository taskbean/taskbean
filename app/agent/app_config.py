"""Persistent application configuration.

Stored at ~/.taskbean/config.json so settings survive restarts and
reboots. Falls back to safe defaults if the file is missing or corrupt.

Config keys
-----------
modelPermission   "ask" | "yolo"
                  "ask"  — emit a recommendation event; user must confirm
                           downloads with forceDownload=true.
                  "yolo" — auto-download and load the best model without
                           prompting, streaming progress events.

preferredDevice   "auto" | "npu" | "gpu" | "cpu"
                  "auto" — choose highest-performance device available.

preferredModel    str | null
                  Explicit override: always load this modelId if set.
                  Cleared to null if the model is removed from the catalog.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone as _tz
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)

_CONFIG_DIR = Path.home() / ".taskbean"
_OLD_CONFIG_DIR = Path.home() / ".foundry-local-demo"
_CONFIG_FILE = _CONFIG_DIR / "config.json"

_DEFAULTS: dict = {
    "modelPermission": "ask",
    "preferredDevice": "auto",
    "preferredModel": None,
    "runOnStartup": False,
    "autoSelectIcon": True,
    "timezone": None,               # None = use OS default; or IANA timezone string like "America/New_York"
    "hideIncompatibleModels": False,
    "toolCallOnly": False,
    "speech": {
        "engine": "auto",       # "auto" | "web" | "whisper" | "live"
        "fallback": "whisper",  # "web" | "whisper" | "none"
        "micDevice": None,      # null = system default, or device label/id string
        "liveModel": False,     # true once user opts into the Nemotron streaming tier
    },
    "schedule": {
        "dnd": {
            "start": "23:00",
            "end": "07:00",
            "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            "enabled": False,
        },
        "reminderHours": {
            "start": "08:00",
            "end": "22:00",
            "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            "enabled": False,
        },
    },
}

# In-memory representation loaded at startup.
_config: dict = {}

# Prevents concurrent model-switch operations.
_switch_lock: asyncio.Lock | None = None


# ── Persistence ───────────────────────────────────────────────────────────────

def load() -> dict:
    """Load config from disk (or defaults). Call once at startup."""
    global _config
    _config = dict(_DEFAULTS)
    # Migrate legacy config directory if new one doesn't exist yet
    if not _CONFIG_FILE.exists() and _OLD_CONFIG_DIR.exists():
        old_file = _OLD_CONFIG_DIR / "config.json"
        if old_file.exists():
            try:
                _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
                import shutil
                shutil.copy2(old_file, _CONFIG_FILE)
                logger.info("Migrated config from %s to %s", old_file, _CONFIG_FILE)
            except Exception as exc:
                logger.warning("Config migration failed: %s", exc)
    if _CONFIG_FILE.exists():
        try:
            on_disk = json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
            for key in _DEFAULTS:
                if key in on_disk:
                    _config[key] = on_disk[key]
            logger.info("Loaded app config from %s", _CONFIG_FILE)
        except Exception as exc:
            logger.warning("Could not read config file, using defaults: %s", exc)
    else:
        logger.info("No config file found, using defaults")
    # Migrate legacy speech.engine/fallback == "sapi" to "whisper".
    # The "sapi" backend was removed; without this the validator in main.py
    # would reject the user's existing config on first POST /api/config.
    speech = _config.get("speech")
    if isinstance(speech, dict):
        migrated = False
        if speech.get("engine") == "sapi":
            speech["engine"] = "whisper"
            migrated = True
        if speech.get("fallback") == "sapi":
            speech["fallback"] = "whisper"
            migrated = True
        if migrated:
            logger.info("Migrated legacy speech.engine='sapi' -> 'whisper' in config")
            _config["speech"] = speech
            save()
    return _config


def save() -> None:
    """Persist current in-memory config to disk."""
    try:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        out = {**_config, "lastUpdated": datetime.now(_tz.utc).isoformat().replace("+00:00", "Z")}
        _CONFIG_FILE.write_text(json.dumps(out, indent=2), encoding="utf-8")
    except Exception as exc:
        logger.warning("Could not save config: %s", exc)


# ── Accessors ─────────────────────────────────────────────────────────────────

def get(key: str):
    return _config.get(key, _DEFAULTS.get(key))


def set(key: str, value) -> None:  # noqa: A001
    _config[key] = value
    save()


def all_settings() -> dict:
    return dict(_config)


# ── Typed shorthand properties ────────────────────────────────────────────────

def model_permission() -> Literal["ask", "yolo"]:
    return _config.get("modelPermission", "ask")


def preferred_device() -> Literal["auto", "npu", "gpu", "cpu"]:
    return _config.get("preferredDevice", "auto")


def preferred_model() -> str | None:
    return _config.get("preferredModel")


def speech_config() -> dict:
    """Return speech configuration."""
    defaults = _DEFAULTS.get("speech", {})
    stored = _config.get("speech", {})
    return {**defaults, **stored}


def run_on_startup() -> bool:
    return bool(_config.get("runOnStartup", False))


def timezone() -> str | None:
    return _config.get("timezone")


def dnd_schedule() -> dict:
    schedule = _config.get("schedule", {})
    return schedule.get("dnd", _DEFAULTS["schedule"]["dnd"])


def reminder_hours() -> dict:
    schedule = _config.get("schedule", {})
    return schedule.get("reminderHours", _DEFAULTS["schedule"]["reminderHours"])


# ── Switch lock───────────────────────────────────────────────────────────────

def get_switch_lock() -> asyncio.Lock:
    """One lock shared across all model-switch requests."""
    global _switch_lock
    if _switch_lock is None:
        _switch_lock = asyncio.Lock()
    return _switch_lock
