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


# Map Windows ML execution provider name → friendly NPU label.
# Reference: https://learn.microsoft.com/windows/ai/new-windows-ml/supported-execution-providers
_WINML_NPU_PROVIDERS = {
    "VitisAIExecutionProvider": ("AMD NPU (XDNA)", "AMD"),
    "OpenVINOExecutionProvider": ("Intel NPU", "Intel"),
    "QNNExecutionProvider":      ("Qualcomm Hexagon NPU", "Qualcomm"),
}

# Module-level handle for the Windows App SDK runtime so the Shutdown
# object stays alive for the life of the process. Garbage-collecting it
# would shut down the bootstrap and break subsequent catalog calls.
# We deliberately never call shutdown explicitly: the bootstrap is
# process-lifetime, and shutting it down during Python atexit could
# deadlock if other PyWinRT objects are still alive. Letting the OS
# clean up at process exit is the documented pattern for unpackaged
# Python processes per PyWinRT community guidance.
_winml_bootstrap = None


def _detect_npu_winml() -> Optional[NpuInfo]:
    """Detect NPU via Windows ML's ExecutionProviderCatalog (Win 11 24H2+).

    This is the Microsoft-blessed, vendor-agnostic detection path: the
    catalog lists all execution providers Windows ML knows about
    (VitisAI/AMD, OpenVINO/Intel, QNN/Qualcomm). Filtering to providers
    whose ReadyState != NOT_PRESENT tells us which NPUs are *installed*
    on the machine (independent of whether our specific ONNX Runtime
    instance has them registered).

    Requires:
      - Windows 11 24H2+ (build 26100+)
      - wasdk-Microsoft.Windows.AI.MachineLearning
      - wasdk-Microsoft.Windows.ApplicationModel.DynamicDependency.Bootstrap

    Returns None on any failure so callers can fall back to legacy
    PnP-based detection on older Windows or when the wasdk packages
    aren't installed.
    """
    global _winml_bootstrap
    try:
        import winui3.microsoft.windows.applicationmodel.dynamicdependency.bootstrap as _bootstrap
        import winui3.microsoft.windows.ai.machinelearning as _winml
    except ImportError as exc:
        logger.info("Windows ML ExecutionProviderCatalog unavailable (%s) — using legacy PnP detection", exc)
        return None

    try:
        # Bootstrap once per process and hold the shutdown handle —
        # ON_PACKAGE_IDENTITY_NOOP is the documented option for
        # unpackaged processes (plain python.exe): if no Windows App SDK
        # framework package identity is found, fall back to runtime
        # resolution rather than failing. Other options (the default,
        # ON_NO_MATCH_SHOW_UI, ON_ERROR_FAIL_FAST) would either error
        # out or prompt the user to install the WASDK MSI.
        if _winml_bootstrap is None:
            _winml_bootstrap = _bootstrap.initialize(
                options=_bootstrap.InitializeOptions.ON_PACKAGE_IDENTITY_NOOP
            )
        catalog = _winml.ExecutionProviderCatalog.get_default()
        providers = catalog.find_all_providers()
    except Exception as exc:
        logger.warning("Windows ML catalog probe failed (%s: %s)", type(exc).__name__, exc)
        return None

    # ExecutionProviderReadyState semantics per Microsoft Learn:
    #   READY        = installed and registered with ONNX Runtime
    #   NOT_READY    = installed but not yet registered (needs EnsureReadyAsync)
    #   NOT_PRESENT  = not installed on the machine
    # For "is this NPU on the machine?" detection we want READY OR
    # NOT_READY — i.e. anything that isn't NOT_PRESENT — which matches
    # the documented "FindAllProviders().Where(ReadyState != NotPresent)"
    # idiom for installed-providers discovery.
    not_present = _winml.ExecutionProviderReadyState.NOT_PRESENT
    for p in providers:
        if p.ready_state == not_present:
            continue
        if p.name in _WINML_NPU_PROVIDERS:
            label, _vendor = _WINML_NPU_PROVIDERS[p.name]
            logger.info("NPU detected via Windows ML catalog: %s (provider=%s, ready_state=%s)",
                        label, p.name, p.ready_state)
            luid = _detect_npu_luid()
            return NpuInfo(name=label, luid=luid)
    return None


def _detect_npu() -> Optional[NpuInfo]:
    """Find an NPU on this machine.

    Layered strategy:
    1. Windows ML ExecutionProviderCatalog (vendor-blessed, Win 11 24H2+).
    2. Legacy PnP-name regex fallback for older Windows or when the
       wasdk packages aren't available.

    Returns the first match; None if neither path finds anything.
    """
    npu = _detect_npu_winml()
    if npu is not None:
        return npu

    # Legacy PnP-name fallback. Loose regex — known to match some
    # USB devices ('USB Input Device') so it's only used when the
    # modern catalog API isn't available.
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
    logger.info("NPU detected via legacy PnP regex (catalog unavailable): %s", name)
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


def _detect_gpu_dxgi() -> list[GpuInfo]:
    """Enumerate adapters via DXGI to get accurate 64-bit VRAM.

    Win32_VideoController.AdapterRAM is uint32 and silently truncates past
    ~4 GB — DXGI's IDXGIAdapter::GetDesc returns DedicatedVideoMemory as
    SIZE_T (64-bit on x64), so this is the only correct API for modern
    cards. Documented at:
    https://learn.microsoft.com/windows/win32/api/dxgi/nf-dxgi-idxgiadapter-getdesc

    Returns a list of (name, vram_gb) for all adapters DXGI can see.
    Returns [] on any failure (no DirectX, missing dxgi.dll, etc.).
    """
    import ctypes
    from ctypes import wintypes

    # IDXGIAdapter::GetDesc fills DXGI_ADAPTER_DESC. Layout per
    # https://learn.microsoft.com/windows/win32/api/dxgi/ns-dxgi-dxgi_adapter_desc
    class DXGI_ADAPTER_DESC(ctypes.Structure):
        _fields_ = [
            ("Description", wintypes.WCHAR * 128),
            ("VendorId", wintypes.UINT),
            ("DeviceId", wintypes.UINT),
            ("SubSysId", wintypes.UINT),
            ("Revision", wintypes.UINT),
            ("DedicatedVideoMemory", ctypes.c_size_t),
            ("DedicatedSystemMemory", ctypes.c_size_t),
            ("SharedSystemMemory", ctypes.c_size_t),
            ("AdapterLuid", ctypes.c_int64),
        ]

    try:
        dxgi = ctypes.WinDLL("dxgi.dll")
    except OSError as exc:
        logger.warning("dxgi.dll not loadable (%s) — skipping DXGI VRAM enumeration", exc)
        return []

    # IID_IDXGIFactory = {7b7166ec-21c7-44ae-b21a-c9ae321ae369}
    IID_IDXGIFactory = (ctypes.c_ubyte * 16)(
        0xec, 0x66, 0x71, 0x7b, 0xc7, 0x21, 0xae, 0x44,
        0xb2, 0x1a, 0xc9, 0xae, 0x32, 0x1a, 0xe3, 0x69,
    )

    factory = ctypes.c_void_p()
    create = dxgi.CreateDXGIFactory
    create.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    create.restype = ctypes.c_long
    hr = create(IID_IDXGIFactory, ctypes.byref(factory))
    if hr != 0 or not factory.value:
        logger.warning("CreateDXGIFactory failed (hr=0x%x)", hr & 0xFFFFFFFF)
        return []

    # vtable layout for IDXGIAdapter (and IDXGIFactory) per the COM ABI:
    #   IUnknown(0..2):    QueryInterface, AddRef, Release
    #   IDXGIObject(3..6): SetPrivateData, SetPrivateDataInterface,
    #                       GetPrivateData, GetParent
    #   IDXGIFactory(7..): EnumAdapters, ...
    #   IDXGIAdapter(7..): EnumOutputs, GetDesc, CheckInterfaceSupport
    # So GetDesc lives at v-table slot 8 of IDXGIAdapter (slot 7 is
    # EnumOutputs). EnumAdapters is slot 7 of IDXGIFactory.
    def _vfn(this, idx, restype, argtypes):
        vtbl = ctypes.cast(this, ctypes.POINTER(ctypes.c_void_p))[0]
        addr = ctypes.cast(vtbl, ctypes.POINTER(ctypes.c_void_p))[idx]
        proto = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)
        return proto(addr)

    EnumAdapters = _vfn(factory, 7, ctypes.c_long, [wintypes.UINT, ctypes.POINTER(ctypes.c_void_p)])
    Release = _vfn(factory, 2, ctypes.c_ulong, [])

    results: list[GpuInfo] = []
    try:
        idx = 0
        while True:
            adapter = ctypes.c_void_p()
            hr = EnumAdapters(factory, idx, ctypes.byref(adapter))
            if hr != 0:
                break  # DXGI_ERROR_NOT_FOUND ends the enumeration
            try:
                desc = DXGI_ADAPTER_DESC()
                GetDesc = _vfn(adapter, 8, ctypes.c_long, [ctypes.POINTER(DXGI_ADAPTER_DESC)])
                AdapterRelease = _vfn(adapter, 2, ctypes.c_ulong, [])
                if GetDesc(adapter, ctypes.byref(desc)) == 0:
                    name = desc.Description.strip()
                    vram_gb = desc.DedicatedVideoMemory / (1024 ** 3)
                    if name and not re.search(r"basic display|microsoft basic|remote desktop", name, re.I):
                        results.append(GpuInfo(name=name, vram_gb=round(vram_gb, 1)))
                AdapterRelease(adapter)
            except Exception as exc:
                logger.debug("DXGI adapter[%d] read failed: %s", idx, exc)
            idx += 1
    finally:
        Release(factory)

    return results


def _detect_gpu_wmi_name() -> list[str]:
    """Enumerate GPU adapter names via in-process WMI (pywin32).

    Used as a fallback when DXGI enumeration fails (e.g. system without
    DirectX 12). Drops the wmic CLI dependency that was broken on
    Windows 11 24H2+.
    """
    try:
        import win32com.client  # type: ignore[import-untyped]
    except ImportError as exc:
        logger.warning("pywin32 not available (%s) — falling back to wmic for GPU name", exc)
        return []
    try:
        wmi = win32com.client.GetObject("winmgmts:\\\\.\\root\\cimv2")
        items = wmi.ExecQuery("SELECT Name FROM Win32_VideoController WHERE Name IS NOT NULL")
        return [str(item.Name).strip() for item in items if str(item.Name).strip()]
    except Exception as exc:
        logger.warning("WMI Win32_VideoController query failed: %s", exc)
        return []


def _detect_gpu() -> Optional[GpuInfo]:
    """Return the best discrete GPU found, or None.

    Strategy: DXGI first (gives accurate 64-bit VRAM), then merge with
    WMI for any adapter DXGI missed (rare, but DXGI requires DirectX 12).
    Drops the legacy `wmic` CLI which was removed on Windows 11 24H2+.
    """
    # Filter out integrated software adapters and remote-session shims.
    def _keep(name: str) -> bool:
        return bool(name) and not re.search(r"basic display|microsoft basic|remote desktop", name, re.I)

    candidates: list[GpuInfo] = list(_detect_gpu_dxgi())

    # Backfill any adapter WMI knows about that DXGI didn't surface.
    seen = {g.name.lower() for g in candidates}
    for name in _detect_gpu_wmi_name():
        if not _keep(name):
            continue
        if name.lower() in seen:
            continue
        # No VRAM info from this path — DXGI would have provided it. Mark as 0.
        # The recommender's max_model_gb already gates on vram_gb > 0.
        candidates.append(GpuInfo(name=name, vram_gb=0.0))
        seen.add(name.lower())

    if not candidates:
        return None
    # Prefer the adapter with the highest VRAM (typically the discrete GPU).
    candidates.sort(key=lambda g: g.vram_gb, reverse=True)
    return candidates[0]


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
