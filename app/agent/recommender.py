"""Model recommendation engine.

Given the hardware profile, user preferences, and a list of catalog models,
scores and ranks candidates for a given task.

Scoring dimensions
------------------
1. Device fit       — matches preferred_device (or best available in "auto" mode)
2. Task capability  — model's task list includes the required capability
3. Output budget    — higher maxOutputTokens → more reliable tool calls / richer responses
4. Memory fit       — model file size must fit within device memory headroom
5. Model quality    — larger parameter count generally performs better up to a point

Tasks
-----
"tool_calling"  — requires "tools" in model task list; rewards high output tokens
"large_input"   — rewards high maxInputTokens
"general"       — balanced score
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from hardware import HardwareProfile

logger = logging.getLogger(__name__)


# ── Device ordering ───────────────────────────────────────────────────────────

_DEVICE_RANK = {"NPU": 3, "GPU": 2, "CPU": 1}


def _device_score(device: str, hw: "HardwareProfile", preferred: str) -> float:
    """Score 0–30 based on device match and hardware availability."""
    d = device.upper()

    # Hard exclusion: device not available on this machine
    if d == "NPU" and not hw.npu:
        return -1000
    if d == "GPU" and not hw.gpu:
        return -1000

    if preferred == "auto":
        # Prefer NPU > GPU > CPU on capable hardware
        return _DEVICE_RANK.get(d, 0) * 10
    else:
        # User has an explicit preference
        return 30 if d == preferred.upper() else (_DEVICE_RANK.get(d, 0) * 2)


def _output_token_score(max_out: int | None) -> float:
    """Score 0–20 for output token budget (critical for tool calling)."""
    if not max_out:
        return 0
    if max_out >= 8192:
        return 20
    if max_out >= 4096:
        return 15
    if max_out >= 1024:
        return 10
    if max_out >= 512:
        return 5
    return 0  # 256 tokens — unreliable for tool calls


def _input_token_score(max_in: int | None) -> float:
    """Score 0–10 for input token budget (matters for large-input tasks)."""
    if not max_in:
        return 0
    if max_in >= 65536:
        return 10
    if max_in >= 16384:
        return 7
    if max_in >= 4096:
        return 4
    return 1


def _size_score(param_b: float | None, file_gb: float | None,
                device: str, hw: "HardwareProfile") -> float:
    """Score -100–15 for model quality vs memory fit."""
    if file_gb is None:
        return 0

    budget = hw.max_model_gb(device)
    if budget > 0 and file_gb > budget:
        return -100  # model won't fit

    # Larger models (more params) generally perform better, up to diminishing returns
    if param_b is None:
        # Estimate from file size
        param_b = file_gb / 0.7  # rough: 0.7 GB per billion params (4-bit quant)

    return min(param_b * 1.5, 15)


def score_model(
    model: dict,
    task: str,
    hw: "HardwareProfile",
    preferred_device: str,
) -> float:
    """Compute a scalar score for a catalog model entry."""
    total = 0.0
    device = model.get("device", "CPU")
    tasks: list[str] = model.get("tasks", [])

    # 1. Device fit
    dev = _device_score(device, hw, preferred_device)
    if dev <= -1000:
        return dev  # hard exclusion
    total += dev

    # 2. Task capability
    if task == "tool_calling":
        if "tools" not in tasks:
            return -1000  # hard exclusion — can't do tool calling
        total += 50  # baseline bonus for having the capability
        total += _output_token_score(model.get("maxOutputTokens"))
    elif task == "large_input":
        total += _input_token_score(model.get("maxInputTokens"))
        total += _output_token_score(model.get("maxOutputTokens")) * 0.5
    else:  # "general"
        total += _output_token_score(model.get("maxOutputTokens")) * 0.5
        total += _input_token_score(model.get("maxInputTokens")) * 0.5

    # 3. Memory fit + quality
    total += _size_score(
        model.get("paramBillions"),
        model.get("fileSizeGb"),
        device,
        hw,
    )

    return total


def rank_models(
    catalog: list[dict],
    task: str,
    hw: "HardwareProfile",
    preferred_device: str,
    exclude_model_id: str | None = None,
) -> list[dict]:
    """Return catalog models sorted best-first for a given task and hardware.

    Each returned entry is augmented with a ``_score`` key.
    Models with score < 0 (hard exclusions) are omitted.
    """
    scored = []
    for m in catalog:
        if exclude_model_id and m["modelId"] == exclude_model_id:
            continue
        s = score_model(m, task, hw, preferred_device)
        if s >= 0:
            scored.append({**m, "_score": round(s, 1)})
    scored.sort(key=lambda x: x["_score"], reverse=True)
    return scored


def best_for_task(
    catalog: list[dict],
    task: str,
    hw: "HardwareProfile",
    preferred_device: str,
    exclude_model_id: str | None = None,
    require_loaded: bool = False,
) -> dict | None:
    """Return the top-ranked model for a task, or None if no suitable model."""
    ranked = rank_models(catalog, task, hw, preferred_device, exclude_model_id)
    if require_loaded:
        ranked = [m for m in ranked if m.get("loaded")]
    return ranked[0] if ranked else None
