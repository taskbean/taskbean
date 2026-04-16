"""Scanner registry."""

from __future__ import annotations

from ..types import AgentScanner
from .copilot import CopilotScanner
from .claude_code import ClaudeCodeScanner
from .codex import CodexScanner
from .opencode import OpenCodeScanner


def all_scanners() -> list[AgentScanner]:
    return [CopilotScanner(), ClaudeCodeScanner(), CodexScanner(), OpenCodeScanner()]


__all__ = [
    "all_scanners",
    "CopilotScanner",
    "ClaudeCodeScanner",
    "CodexScanner",
    "OpenCodeScanner",
]
