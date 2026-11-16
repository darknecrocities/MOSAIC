"""Hardware capability profiling with explicit provenance and zero fabrication."""

from __future__ import annotations

import platform
from typing import Any

import psutil

from mosaic_analytics.protocol import JobContext


def _detect_apple_silicon() -> tuple[bool, str | None]:
    """Identify Apple Silicon host architecture for unified-memory accounting."""
    sys_name = platform.system()
    machine = platform.machine().lower()
    if sys_name == "Darwin" and machine in {"arm64", "aarch64"}:
        return True, platform.processor() or "Apple Silicon"
    return False, None


def _probe_nvidia_nvml() -> list[dict[str, Any]]:
    """Probe NVIDIA GPUs via pynvml only when compatible bindings/drivers exist."""
    try:
        import pynvml  # type: ignore[import-not-found]
    except ImportError:
        return []

    gpus: list[dict[str, Any]] = []
    try:
        pynvml.nvmlInit()
        count = pynvml.nvmlDeviceGetCount()
        for idx in range(count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(idx)
            name = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode("utf-8", errors="replace")
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            gpus.append(
                {
                    "index": idx,
                    "vendor": "nvidia",
                    "model": str(name),
                    "vram_total_bytes": int(mem.total),
                    "vram_free_bytes": int(mem.free),
                    "source": "measured",
                }
            )
    except Exception:  # noqa: BLE001
        return []
    finally:
        try:
            pynvml.nvmlShutdown()
        except Exception:  # noqa: BLE001
            pass
    return gpus


def analyze_hardware(_params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
    """Collect cross-platform CPU, memory, and optional GPU measurements."""
    vm = psutil.virtual_memory()
    is_unified, chip_hint = _detect_apple_silicon()
    limitations: list[str] = []

    nvidia_gpus = _probe_nvidia_nvml()
    if nvidia_gpus:
        gpu_report: dict[str, Any] = {
            "status": "measured",
            "unified_memory": False,
            "devices": nvidia_gpus,
        }
    elif is_unified:
        gpu_report = {
            "status": "unified_memory",
            "unified_memory": True,
            "devices": [
                {
                    "index": 0,
                    "vendor": "apple",
                    "model": chip_hint or "Apple Silicon GPU",
                    "vram_total_bytes": None,
                    "vram_free_bytes": None,
                    "note": "Shares unified system RAM; do not double-count with RAM.",
                    "source": "inferred",
                }
            ],
        }
        limitations.append(
            "Apple Silicon uses unified memory shared between CPU and GPU; "
            "discrete VRAM is not reported separately."
        )
    else:
        gpu_report = {
            "status": "unknown",
            "unified_memory": False,
            "devices": [],
        }
        limitations.append(
            "No supported GPU telemetry library (NVML/ROCm) detected; GPU reported as unknown."
        )

    return {
        "value": {
            "os": {
                "system": platform.system(),
                "release": platform.release(),
                "version": platform.version(),
                "architecture": platform.machine(),
            },
            "cpu": {
                "physical_cores": psutil.cpu_count(logical=False),
                "logical_cores": psutil.cpu_count(logical=True),
                "processor": platform.processor() or "unknown",
            },
            "memory": {
                "total_bytes": int(vm.total),
                "available_bytes": int(vm.available),
                "used_percent": float(vm.percent),
                "is_unified_memory": is_unified,
            },
            "gpu": gpu_report,
        },
        "unit": "bytes",
        "source": "measured",
        "confidence": "high" if not limitations else "medium",
        "limitations": limitations,
    }
