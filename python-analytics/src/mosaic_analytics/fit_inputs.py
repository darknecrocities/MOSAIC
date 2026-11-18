"""Input normalization and parameter validation helpers for model-fit assessment."""

from __future__ import annotations

import math
from typing import Any

from mosaic_analytics.execution_planner import (
    HardwareMemoryBudget,
    normalize_profile,
    resolve_memory_budget,
)
from mosaic_analytics.numeric import MAX_SAFE_BYTES, MAX_SAFE_COUNT, safe_float, safe_int


def is_pos_num(val: Any) -> bool:
    """Return True when val is a finite positive int/float (excluding bool)."""
    if not isinstance(val, int | float) or isinstance(val, bool):
        return False
    try:
        return math.isfinite(float(val)) and val > 0
    except (TypeError, ValueError, OverflowError):
        return False


def normalize_hardware(params: dict[str, Any]) -> dict[str, Any]:
    """Normalize hardware or system_profile payloads into budget-ready fields."""
    raw_hw = params.get("hardware")
    if isinstance(raw_hw, dict) and raw_hw:
        return dict(raw_hw)
    raw_sp = params.get("system_profile")
    if not isinstance(raw_sp, dict) or not raw_sp:
        return {}
    vram = raw_sp.get("gpu_vram_bytes")
    if vram is None and not raw_sp.get("is_unified_memory"):
        raw_gpus = raw_sp.get("gpus")
        gpus = raw_gpus if isinstance(raw_gpus, list) else []
        gpu_vrams = [
            safe_int(
                g.get("vram_total_bytes")
                if g.get("vram_total_bytes") is not None
                else g.get("vram_bytes"),
                0,
                max_value=MAX_SAFE_BYTES,
            )
            for g in gpus
            if isinstance(g, dict)
        ]
        vram = max(gpu_vrams, default=0) or None
    return {
        "is_unified_memory": raw_sp.get("is_unified_memory", False),
        "ram_total_bytes": raw_sp.get("ram_total_bytes", 0),
        "ram_available_bytes": raw_sp.get("ram_available_bytes", 0),
        "ram_effective_avail_bytes": raw_sp.get("ram_effective_avail_bytes"),
        "psutil_available_bytes": raw_sp.get("psutil_available_bytes"),
        "metal_wired_limit_bytes": raw_sp.get("metal_wired_limit_bytes"),
        "gpu_vram_bytes": vram,
        "physical_cores": raw_sp.get("physical_cores"),
        "logical_cores": raw_sp.get("logical_cores"),
        "probe_psutil": raw_sp.get("probe_psutil", False),
    }


def parse_fit_params(
    params: dict[str, Any],
) -> tuple[str, int, str, str | None, int, HardwareMemoryBudget]:
    """Parse common single/batch fit request parameters with safe defaults."""
    storage = params.get("storage")
    st = storage if isinstance(storage, dict) else {}
    media_kind = str(st.get("media_kind") or params.get("media_kind") or "unknown").upper()
    raw_ctx = params.get("context_length")
    context_length = (
        4096 if raw_ctx is None else max(512, safe_int(raw_ctx, 4096, max_value=MAX_SAFE_COUNT))
    )
    raw_res = params.get("safety_reserve_gib")
    reserve_gib = 2.0 if raw_res is None else max(0.0, safe_float(raw_res, 2.0))
    raw_par = params.get("num_parallel")
    num_parallel = (
        1 if raw_par is None else max(1, safe_int(raw_par, 1, max_value=MAX_SAFE_COUNT))
    )
    budget = resolve_memory_budget(normalize_hardware(params), reserve_gib)
    profile = normalize_profile(params.get("execution_profile"))
    return media_kind, context_length, profile, params.get("kv_cache_type"), num_parallel, budget
