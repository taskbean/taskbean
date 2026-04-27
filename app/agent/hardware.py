"""Hardware detection for model recommendation scoring.

Detects NPU, GPU (name + VRAM), and CPU (cores + RAM) using Windows-native
WMI queries and Foundry Local's loaded-model list as a secondary NPU signal.
Results are cached for the process lifetime — hardware doesn't change at runtime.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

_cache: "HardwareProfile | None" = None


@dataclass
class GpuInfo:
    name: str
    vram_gb: float


@dataclass
class NpuInfo:
    name: str
    luid: str | None = None


@dataclass
class HardwareProfile:
    npu: Optional[NpuInfo] = None
    gpu: Optional[GpuInfo] = None
    cpu_cores: int = 1
    ram_gb: float = 0.0

    @property
    def has_npu(self) -> bool:
        return self.npu is not None

    def to_dict(self) -> dict:
        return {
            "npu": {"name": self.npu.name, "luid": self.npu.luid} if self.npu else None,
            "gpu": {"name": self.gpu.name, "vramGb": round(self.gpu.vram_gb, 1)} if self.gpu else None,
            "cpu": {"cores": self.cpu_cores, "ramGb": round(self.ram_gb, 1)},
        }

    def max_model_gb(self, device: str) -> float:
        """Conservative upper bound on model file size that fits on a device."""
        d = device.upper()
        if d == "NPU":
            # NPU VRAM is fixed silicon; if NPU exists assume ~6 GB usable
            return 6.0 if self.npu else 0.0
        if d == "GPU":
            return self.gpu.vram_gb * 0.85 if self.gpu else 0.0
        # CPU — use ~60 % of system RAM (leave headroom for OS + app)
        return self.ram_gb * 0.60


def _wmic(query: str, timeout: int = 10) -> str:
    try:
        r = subprocess.run(query, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.stdout
    except Exception:
        return ""


def _detect_npu() -> Optional[NpuInfo]:
    """Check Windows PnP devices for known NPU identifiers, then discover LUID."""
    out = _wmic(
        'powershell -NoProfile -Command '
        '"Get-PnpDevice -Status OK | Where-Object { '
        '$_.FriendlyName -match \'NPU|Neural|AI Accelerator|Qualcomm AI|Intel AI\' } | '
        'Select-Object -ExpandProperty FriendlyName"',
        timeout=15,
    )
    if not out.strip():
        return None
    name = out.strip().splitlines()[0]
    logger.info("NPU detected: %s", name)
    luid = _detect_npu_luid()
    return NpuInfo(name=name, luid=luid)


def _detect_npu_luid() -> str | None:
    """Discover NPU LUID from GPU Engine PDH counters.

    NPU adapters expose only 'compute' engine types (no '3d', 'copy', 'video').
    If multiple compute-only adapters are found, returns None to avoid guessing.
    """
    try:
        out = _wmic(
            "powershell -NoProfile -Command \"(Get-Counter '\\GPU Engine(*)\\Utilization Percentage').CounterSamples "
            "| Select-Object -Property InstanceName | ConvertTo-Json -Compress\"",
            timeout=20,
        )
        if not out.strip():
            return None
        data = json.loads(out)
        adapters: dict[str, set[str]] = {}
        for item in data:
            m = re.match(
                r"pid_\d+_luid_(0x\w+_0x\w+)_phys_\d+_eng_\d+_engtype_(.+)",
                item.get("InstanceName", ""),
            )
            if not m:
                continue
            luid, engtype = m.group(1), m.group(2).strip()
            adapters.setdefault(luid, set()).add(engtype)

        candidates = []
        for luid, engs in adapters.items():
            has_3d = any("3d" in e for e in engs)
            has_copy = any("copy" in e for e in engs)
            has_video = any("video" in e for e in engs)
            has_compute = any("compute" in e for e in engs)
            if has_compute and not has_3d and not has_copy and not has_video:
                candidates.append(luid)

        if len(candidates) == 1:
            logger.info("NPU LUID detected: %s (engines: %s)", candidates[0], ", ".join(sorted(adapters[candidates[0]])))
            return candidates[0]
        if len(candidates) > 1:
            logger.warning("Multiple compute-only adapters found (%s), skipping NPU usage monitoring", ", ".join(candidates))
        return None
    except Exception as e:
        logger.warning("NPU LUID detection failed: %s", e)
        return None


def _detect_gpu() -> Optional[GpuInfo]:
    """Return the best discrete GPU found via WMI, or None."""
    out = _wmic("wmic path win32_VideoController get name,AdapterRAM /format:list")
    names = re.findall(r"Name=(.+)", out)
    vrams = re.findall(r"AdapterRAM=(\d+)", out)
    best: Optional[GpuInfo] = None
    for name, vram_str in zip(names, vrams + ["0"] * len(names)):
        name = name.strip()
        if not name or re.search(r"basic display|microsoft basic|remote desktop", name, re.I):
            continue
        vram_gb = int(vram_str) / (1024 ** 3)
        # Prefer discrete GPUs (higher VRAM wins)
        if best is None or vram_gb > best.vram_gb:
            best = GpuInfo(name=name, vram_gb=round(vram_gb, 1))
    return best


def _detect_ram() -> float:
    # psutil is the canonical, in-process source on every supported
    # platform — try it first. Fall back to wmic only if psutil isn't
    # available; on Windows 11 24H2+ wmic itself is missing by default
    # (Feature on Demand) so a wmic-first ordering is wasteful.
    try:
        import psutil
        gb = psutil.virtual_memory().total / (1024 ** 3)
        logger.info("ram_gb detected via psutil: %.1f", gb)
        return gb
    except Exception as exc:
        logger.warning("psutil RAM detection failed (%s: %s) — falling back to wmic", type(exc).__name__, exc)
    out = _wmic("wmic OS get TotalVisibleMemorySize /value")
    m = re.search(r"TotalVisibleMemorySize=(\d+)", out)
    if m:
        gb = int(m.group(1)) / (1024 * 1024)  # KB → GB
        logger.info("ram_gb detected via wmic fallback: %.1f", gb)
        return gb
    logger.warning("ram_gb detection failed (psutil unavailable + wmic returned no data — likely Win 11 24H2+ where wmic is removed)")
    return 0.0


def detect_hardware(force: bool = False) -> HardwareProfile:
    """Detect and cache hardware profile. Pass force=True to re-detect."""
    global _cache
    if _cache is not None and not force:
        return _cache

    profile = HardwareProfile(cpu_cores=os.cpu_count() or 1)
    logger.info("cpu_cores detected: %d", profile.cpu_cores)
    profile.ram_gb = _detect_ram()
    profile.gpu = _detect_gpu()
    logger.info("gpu detected: %s", profile.gpu.name if profile.gpu else "none")
    profile.npu = _detect_npu()
    logger.info("npu detected: %s", profile.npu.name if profile.npu else "none")

    # Secondary NPU signal: check if the active Foundry model ID contains "npu",
    # which means Foundry already loaded an NPU model successfully.
    # This avoids making an HTTP call from inside a thread (anyio conflict risk).
    if not profile.npu:
        try:
            import agent as agent_mod  # local import to avoid circular dep at module load
            if "npu" in agent_mod.MODEL_ID.lower():
                logger.info("NPU inferred from active model: %s", agent_mod.MODEL_ID)
                profile.npu = NpuInfo(name="NPU (inferred from model)")
        except Exception:
            pass

    logger.info("Hardware: %s", profile.to_dict())
    _cache = profile
    return profile
