"""Hardware capability profiling with explicit provenance and zero fabrication."""

from __future__ import annotations

import json
import math
import platform
import shutil
import subprocess
from typing import Any

import psutil

from mosaic_analytics.numeric import safe_int
from mosaic_analytics.protocol import JobContext

MIB = 1024 * 1024


def _detect_apple_silicon() -> tuple[bool, str | None]:
    """Identify Apple Silicon host architecture and exact Apple chip brand string."""
    if platform.system() != "Darwin" or platform.machine().lower() not in {"arm64", "aarch64"}:
        return False, None
    try:
        proc = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True, text=True, timeout=2.0, check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return True, proc.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    proc_name = (platform.processor() or "").strip()
    return True, proc_name if (proc_name and proc_name.lower() != "arm") else "Apple Silicon"


def _probe_metal_wired_limit_bytes(total_ram_bytes: int) -> tuple[int, str]:
    """Read Metal wired memory limit via sysctl, falling back to 70% of total RAM."""
    try:
        proc = subprocess.run(
            ["sysctl", "-n", "iogpu.wired_limit_mb"],
            capture_output=True, text=True, timeout=2.0, check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            mb = int(proc.stdout.strip())
            if mb > 0:
                return mb * MIB, "sysctl"
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return int(total_ram_bytes * 0.70), "estimated_70pct"


def _probe_nvidia_nvml() -> list[dict[str, Any]]:
    """Probe NVIDIA GPUs via pynvml only when compatible bindings/drivers exist."""
    try:
        import pynvml  # type: ignore[import-not-found]
    except ImportError:
        return []
    gpus: list[dict[str, Any]] = []
    try:
        pynvml.nvmlInit()
        for idx in range(pynvml.nvmlDeviceGetCount()):
            handle = pynvml.nvmlDeviceGetHandleByIndex(idx)
            name = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode("utf-8", errors="replace")
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            gpus.append({
                "index": idx, "vendor": "nvidia", "model": str(name),
                "vram_total_bytes": int(mem.total), "vram_free_bytes": int(mem.free),
                "source": "measured",
            })
    except Exception:  # noqa: BLE001
        return []
    finally:
        try:
            pynvml.nvmlShutdown()
        except Exception:  # noqa: BLE001
            pass
    return gpus


def _probe_nvidia_smi() -> list[dict[str, Any]]:
    """Fallback NVIDIA GPU probe via nvidia-smi CSV query."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return []
    try:
        proc = subprocess.run(
            [
                exe,
                "--query-gpu=index,name,memory.total,memory.free",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True, text=True, timeout=3.0, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if proc.returncode != 0:
        return []
    gpus: list[dict[str, Any]] = []
    for line in proc.stdout.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            continue
        try:
            idx = int(parts[0])
            total_mib = float(parts[2])
            free_mib = float(parts[3])
            if not (
                math.isfinite(total_mib)
                and math.isfinite(free_mib)
                and total_mib > 0
                and free_mib >= 0
            ):
                continue
            gpus.append({
                "index": idx, "vendor": "nvidia", "model": parts[1],
                "vram_total_bytes": int(total_mib) * MIB,
                "vram_free_bytes": int(free_mib) * MIB, "source": "measured",
            })
        except (ValueError, OverflowError):
            continue
    return gpus


def _probe_rocm_smi() -> list[dict[str, Any]]:
    """Fallback AMD ROCm GPU probe via rocm-smi JSON output."""
    exe = shutil.which("rocm-smi")
    if not exe:
        return []
    try:
        proc = subprocess.run(
            [exe, "--showmeminfo", "vram", "--showproductname", "--json"],
            capture_output=True, text=True, timeout=3.0, check=False,
        )
        data = json.loads(proc.stdout) if (proc.returncode == 0 and proc.stdout.strip()) else {}
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    gpus: list[dict[str, Any]] = []
    for idx, (_card, info) in enumerate(sorted(data.items())):
        if not isinstance(info, dict):
            continue
        try:
            raw_total = info.get("VRAM Total Memory (B)") or 0
            raw_used = info.get("VRAM Total Used Memory (B)") or 0
            if (isinstance(raw_total, float) and not math.isfinite(raw_total)) or (
                isinstance(raw_used, float) and not math.isfinite(raw_used)
            ):
                continue
            total_b = int(raw_total)
            used_b = int(raw_used)
        except (TypeError, ValueError, OverflowError):
            continue
        if total_b <= 0:
            continue
        gpus.append({
            "index": idx, "vendor": "amd",
            "model": str(info.get("Card Series") or info.get("Card Model") or "AMD ROCm GPU"),
            "vram_total_bytes": total_b, "vram_free_bytes": max(0, total_b - used_b),
            "source": "measured",
        })
    return gpus


def analyze_hardware(params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
    """Collect cross-platform CPU, memory, Metal wired cap, and GPU measurements."""
    vm = psutil.virtual_memory()
    is_unified, chip_hint = _detect_apple_silicon()
    limitations: list[str] = []

    raw_profile = params.get("system_profile")
    sys_profile = raw_profile if isinstance(raw_profile, dict) else {}
    raw_rust_avail = sys_profile.get("ram_available_bytes")
    if raw_rust_avail is None:
        raw_rust_avail = params.get("rust_ram_available_bytes")
    rust_avail = max(0, safe_int(raw_rust_avail, 0))
    ram_effective_avail = min(int(vm.total), max(rust_avail, int(vm.available)))
    metal_limit_bytes, metal_limit_source = (
        _probe_metal_wired_limit_bytes(int(vm.total)) if is_unified else (None, None)
    )

    discrete_gpus = _probe_nvidia_nvml() or _probe_nvidia_smi() or _probe_rocm_smi()
    if discrete_gpus:
        gpu_report = {"status": "measured", "unified_memory": False, "devices": discrete_gpus}
    elif is_unified:
        gpu_report = {
            "status": "unified_memory", "unified_memory": True,
            "devices": [{
                "index": 0, "vendor": "apple", "model": chip_hint or "Apple Silicon GPU",
                "vram_total_bytes": None, "vram_free_bytes": None,
                "note": "Shares unified system RAM; do not double-count with RAM.",
                "source": "inferred",
            }],
        }
        limitations.append(
            "Apple Silicon uses unified memory shared between CPU and GPU; "
            "discrete VRAM is not reported separately."
        )
    else:
        gpu_report = {"status": "unknown", "unified_memory": False, "devices": []}
        limitations.append(
            "No supported GPU telemetry library (NVML/nvidia-smi/ROCm) detected; "
            "GPU reported as unknown."
        )

    return {
        "value": {
            "os": {
                "system": platform.system(), "release": platform.release(),
                "version": platform.version(), "architecture": platform.machine(),
            },
            "cpu": {
                "physical_cores": psutil.cpu_count(logical=False),
                "logical_cores": psutil.cpu_count(logical=True),
                "processor": chip_hint or platform.processor() or "unknown",
            },
            "memory": {
                "total_bytes": int(vm.total), "available_bytes": int(vm.available),
                "ram_effective_avail_bytes": ram_effective_avail,
                "metal_wired_limit_bytes": metal_limit_bytes,
                "metal_wired_limit_source": metal_limit_source,
                "used_percent": float(vm.percent), "is_unified_memory": is_unified,
            },
            "ram_effective_avail_bytes": ram_effective_avail,
            "metal_wired_limit_bytes": metal_limit_bytes,
            "gpu_devices": gpu_report["devices"],
            "gpu": gpu_report,
        },
        "unit": "bytes",
        "source": "measured",
        "confidence": "high" if not limitations else "medium",
        "limitations": limitations,
    }
