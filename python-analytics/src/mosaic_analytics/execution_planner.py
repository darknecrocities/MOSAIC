"""Adaptive execution profile policies, Metal/VRAM budgeting, and offload planning."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import psutil

from mosaic_analytics.numeric import safe_int

GIB = 1024**3
EXECUTION_PROFILES = ("auto_adaptive", "max_quality", "balanced", "constrained_memory")


@dataclass(frozen=True)
class HardwareMemoryBudget:
    """Resolved memory budgets across GPU/Metal fast tier and CPU spill tier."""

    backend: str
    is_unified_memory: bool
    ram_total_bytes: int
    ram_effective_avail_bytes: int
    metal_wired_cap_bytes: int
    gpu_budget_bytes: int
    cpu_spill_budget_bytes: int
    available_budget_bytes: int
    physical_cores: int


def resolve_effective_ram_avail(hardware: dict[str, Any]) -> int:
    """Resolve effective available RAM without corrupting synthetic constrained fixtures."""
    ram_total = max(0, safe_int(hardware.get("ram_total_bytes"), 0))

    def cap(v: int) -> int:
        return min(ram_total, max(0, v)) if ram_total > 0 else max(0, v)

    if hardware.get("ram_effective_avail_bytes") is not None:
        return cap(safe_int(hardware.get("ram_effective_avail_bytes"), 0))

    rust_avail = max(0, safe_int(hardware.get("ram_available_bytes"), 0))
    if hardware.get("psutil_available_bytes") is not None:
        return cap(max(rust_avail, safe_int(hardware.get("psutil_available_bytes"), 0)))

    if bool(hardware.get("probe_psutil")) or rust_avail <= 0:
        return cap(max(rust_avail, int(psutil.virtual_memory().available)))
    return max(0, rust_avail)


def resolve_memory_budget(
    hardware: dict[str, Any], reserve_gib: float = 2.0
) -> HardwareMemoryBudget:
    """Compute GPU/Metal wired budget, CPU spill budget, and physical thread count."""
    reserve_bytes = int(max(0.0, reserve_gib) * GIB)
    is_unified = bool(hardware.get("is_unified_memory"))
    vram_raw = hardware.get("gpu_vram_bytes")
    ram_total = max(0, safe_int(hardware.get("ram_total_bytes"), 0))
    ram_effective = resolve_effective_ram_avail(hardware)
    cores_raw = hardware.get("physical_cores") or hardware.get("logical_cores")
    physical_cores = max(
        1,
        safe_int(
            cores_raw,
            psutil.cpu_count(logical=False) or psutil.cpu_count(logical=True) or 4,
        ),
    )

    if is_unified:
        metal_cap = max(0, safe_int(hardware.get("metal_wired_limit_bytes"), 0))
        if metal_cap <= 0:
            metal_cap = int(ram_total * 0.70) if ram_total > 0 else ram_effective
        gpu_budget = max(0, min(ram_effective, metal_cap) - reserve_bytes)
        cpu_spill = max(0, ram_effective - reserve_bytes - gpu_budget)
        return HardwareMemoryBudget(
            "unified_metal", True, ram_total, ram_effective,
            metal_cap, gpu_budget, cpu_spill, gpu_budget, physical_cores,
        )

    if (
        isinstance(vram_raw, int | float)
        and not isinstance(vram_raw, bool)
        and math.isfinite(float(vram_raw))
        and vram_raw > 0
    ):
        gpu_budget = max(0, int(vram_raw) - int(0.5 * GIB))
        cpu_spill = max(0, ram_effective - reserve_bytes)
        return HardwareMemoryBudget(
            "discrete_gpu", False, ram_total, ram_effective,
            0, gpu_budget, cpu_spill, gpu_budget, physical_cores,
        )

    ram_budget = max(0, ram_effective - reserve_bytes)
    return HardwareMemoryBudget(
        "cpu_ram", False, ram_total, ram_effective,
        0, 0, 0, ram_budget, physical_cores,
    )


def normalize_profile(profile: str | None) -> str:
    """Normalize execution profile name to a supported policy."""
    candidate = str(profile or "auto_adaptive").strip().lower()
    return candidate if candidate in EXECUTION_PROFILES else "auto_adaptive"


def resolve_kv_cache_type(
    profile: str,
    requested_kv: str | None,
    f16_demand_bytes: int,
    budget_bytes: int,
    requested_ctx: int,
) -> str:
    """Select KV-cache quantization format based on profile and memory pressure."""
    if requested_kv:
        norm = str(requested_kv).strip().lower()
        if norm in {"f16", "q8_0", "q4_0"}:
            return norm
    if profile == "constrained_memory":
        return "q4_0"
    if profile == "balanced":
        return "q8_0"
    if profile == "max_quality":
        return "q8_0" if requested_ctx >= 32768 else "f16"
    if budget_bytes <= 0:
        return "q4_0"
    ratio = f16_demand_bytes / budget_bytes
    return "q4_0" if ratio > 0.88 else ("q8_0" if ratio > 0.65 else "f16")


def _resolve_plan_num_ctx(
    profile: str,
    requested_ctx: int,
    base_bytes: int,
    kv_per_token: float,
    budget_bytes: int,
) -> int:
    if profile == "max_quality":
        return requested_ctx
    if profile == "balanced":
        return min(requested_ctx, 8192)
    if profile == "constrained_memory":
        return min(requested_ctx, 4096) if requested_ctx >= 2048 else max(512, requested_ctx)
    if budget_bytes <= 0:
        return min(requested_ctx, 2048)
    if base_bytes + int(kv_per_token * requested_ctx) <= budget_bytes:
        return requested_ctx
    for step in (8192, 4096, 2048):
        if step <= requested_ctx and base_bytes + int(kv_per_token * step) <= budget_bytes:
            return step
    return min(requested_ctx, 2048)


def compute_execution_plan(
    *,
    profile: str,
    kv_cache_type: str,
    requested_ctx: int,
    weight_bytes: int,
    kv_bytes: int,
    overhead_bytes: int,
    n_layers: int,
    budget: HardwareMemoryBudget,
    media_kind: str,
    num_parallel: int = 1,
) -> dict[str, Any]:
    """Synthesize adaptive Ollama / llama.cpp runtime options and safety warnings."""
    safe_req_ctx = max(512, safe_int(requested_ctx, 4096))
    combined_budget = budget.available_budget_bytes + budget.cpu_spill_budget_bytes
    kv_per_token = kv_bytes / safe_req_ctx
    plan_ctx = _resolve_plan_num_ctx(
        profile, safe_req_ctx, weight_bytes + overhead_bytes,
        kv_per_token, budget.available_budget_bytes,
    )
    plan_kv_bytes = kv_bytes if plan_ctx == safe_req_ctx else int(round(kv_per_token * plan_ctx))
    plan_total_required = weight_bytes + plan_kv_bytes + overhead_bytes

    warnings: list[str] = []
    if budget.backend == "cpu_ram" or budget.gpu_budget_bytes <= plan_kv_bytes + overhead_bytes:
        num_gpu, offload_ratio = 0, 0.0
    elif plan_total_required <= budget.gpu_budget_bytes:
        num_gpu, offload_ratio = 999, 1.0
    elif n_layers > 0 and plan_total_required <= combined_budget:
        layer_bytes = max(1.0, weight_bytes / n_layers)
        free_gpu = budget.gpu_budget_bytes - plan_kv_bytes - overhead_bytes
        num_gpu = max(0, min(n_layers, math.floor(free_gpu / layer_bytes)))
        offload_ratio = round(num_gpu / n_layers, 3)
    else:
        num_gpu, offload_ratio = 0, 0.0

    if profile == "max_quality":
        num_batch, num_ubatch, keep_alive = 512, 512, "15m"
    elif profile == "balanced":
        num_batch, num_ubatch, keep_alive = 256, 128, "5m"
    elif profile == "constrained_memory":
        num_batch, num_ubatch, keep_alive = 128, 64, "30s"
    else:
        high_mem = max(budget.ram_total_bytes, combined_budget) >= 24 * GIB
        num_batch, num_ubatch = (512, 512) if high_mem else (256, 128)
        tight = budget.available_budget_bytes > 0 and plan_total_required > int(
            0.80 * budget.available_budget_bytes
        )
        keep_alive = "0" if tight else "5m"

    use_mlock = False
    if profile == "max_quality":
        unified_tight = budget.is_unified_memory and plan_total_required >= int(
            0.60 * budget.gpu_budget_bytes
        )
        if (
            budget.available_budget_bytes > 0
            and plan_total_required < int(0.65 * budget.available_budget_bytes)
            and not unified_tight
        ):
            use_mlock = True
        else:
            warnings.append("Disabled use_mlock to prevent RAM/Metal pinning pressure.")

    if (
        budget.is_unified_memory
        and budget.gpu_budget_bytes < plan_total_required <= combined_budget
    ):
        warnings.append(
            "Demand exceeds Metal wired limit; overflowing layers into non-wired unified RAM."
        )
    if plan_total_required > combined_budget:
        warnings.append(
            "Demand exceeds combined GPU and system RAM budget; disk mmap paging will occur."
        )
    if media_kind == "HDD" and (
        plan_total_required > combined_budget or (0.0 < offload_ratio < 1.0)
    ):
        warnings.append("External HDD/ExFAT mmap thrashing risk under partial or spilled offload.")

    return {
        "profile": profile,
        "kv_cache_type": kv_cache_type,
        "num_ctx": plan_ctx,
        "num_gpu": num_gpu,
        "num_batch": num_batch,
        "num_ubatch": num_ubatch,
        "num_thread": budget.physical_cores,
        "use_mmap": True,
        "use_mlock": use_mlock,
        "keep_alive": keep_alive,
        "flash_attention": True,
        "num_parallel": max(1, safe_int(num_parallel, 1)),
        "offload_ratio": offload_ratio,
        "warnings": warnings,
    }
