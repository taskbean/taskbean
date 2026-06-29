from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping


DEFAULT_PORT = 8275
PORTLESS_NAME = "taskbean"
PORTLESS_URL = f"https://{PORTLESS_NAME}.localhost"


@dataclass(frozen=True)
class RuntimePort:
    port: int
    source: str


def _valid_port(value: object) -> int | None:
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    if 1024 <= port <= 65535:
        return port
    return None


def resolve_runtime_port(
    *,
    env: Mapping[str, str] | None = None,
    config_get: Callable[[str], object | None] | None = None,
) -> RuntimePort:
    env = env if env is not None else os.environ
    config_get = config_get or (lambda _key: None)

    for key in ("TASKBEAN_PORT", "taskbean_PORT", "PORT"):
        port = _valid_port(env.get(key))
        if port is not None:
            return RuntimePort(port=port, source=f"env:{key}")

    port = _valid_port(config_get("port"))
    if port is not None:
        return RuntimePort(port=port, source="config")

    return RuntimePort(port=DEFAULT_PORT, source="default")


def is_portless_detected() -> bool:
    if shutil.which("portless") is not None:
        return True

    app_dir = Path(__file__).resolve().parents[1]
    local_bin = app_dir / "node_modules" / ".bin"
    candidates = (
        local_bin / "portless.cmd",
        local_bin / "portless.ps1",
        local_bin / "portless",
    )
    return any(path.exists() for path in candidates)


def _configured_public_url(config_get: Callable[[str], object | None]) -> str | None:
    value = config_get("publicBaseUrl")
    if isinstance(value, str) and value.strip():
        return value.strip().rstrip("/")
    return None


def _env_public_url(env: Mapping[str, str]) -> str | None:
    for key in ("TASKBEAN_PUBLIC_URL", "PORTLESS_URL"):
        value = env.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().rstrip("/")
    return None


def build_port_info(
    *,
    env: Mapping[str, str] | None = None,
    config_get: Callable[[str], object | None] | None = None,
    portless_detected: bool | None = None,
) -> dict:
    config_get = config_get or (lambda _key: None)
    runtime = resolve_runtime_port(env=env, config_get=config_get)
    env = env if env is not None else os.environ
    detected = is_portless_detected() if portless_detected is None else portless_detected
    fallback_url = f"http://127.0.0.1:{runtime.port}"
    active_portless_url = PORTLESS_URL if detected and runtime.source == "env:PORT" else None
    public_url = _configured_public_url(config_get) or _env_public_url(env) or active_portless_url or fallback_url

    return {
        "port": runtime.port,
        "default": DEFAULT_PORT,
        "source": runtime.source,
        "conflict": None,
        "configurable": True,
        "fallbackUrl": fallback_url,
        "portlessDetected": detected,
        "portlessName": PORTLESS_NAME,
        "portlessUrl": PORTLESS_URL,
        "publicUrl": public_url,
    }
