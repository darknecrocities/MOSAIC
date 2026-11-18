"""Adaptive 3-tier memory and multi-node RPC cluster planner for 30B-200B+ / MoE models."""

from __future__ import annotations

from typing import Any

from mosaic_analytics.cluster_rpc import build_multi_node_rpc_plan, parse_valid_workers
from mosaic_analytics.model_fit_analyzer import GIB, _estimate_kv_cache, _estimate_weights
from mosaic_analytics.numeric import safe_float, safe_int
from mosaic_analytics.protocol import JobContext


def _compute_hot_vs_expert_bytes(
    model: dict[str, Any], weight_bytes: int, kv_bytes: int
) -> tuple[int, int, bool]:
    """Split weight footprint into always-active hot tensors vs routed MoE experts."""
    is_moe = bool(model.get("is_moe"))
    raw_total = model.get("parameter_billions")
    total_b = safe_float(raw_total if raw_total is not None else model.get("params_b"), 0.0)
    raw_active = model.get("active_parameter_billions")
    active_b = safe_float(
        raw_active if raw_active is not None else model.get("active_params_b"), 0.0
    )

    if is_moe and total_b > 0 and 0 < active_b < total_b:
        hot_ratio = max(0.18, min(0.45, active_b / total_b))
        hot_weights = int(weight_bytes * hot_ratio)
        expert_weights = weight_bytes - hot_weights
        return hot_weights + kv_bytes, expert_weights, True

    return weight_bytes + kv_bytes, 0, False


def _resolve_local_tiers(
    local_node: dict[str, Any], reserve_gib: float
) -> tuple[bool, int, int, int]:
    """Return (local_unified, local_fast_tier, local_ram_tier, metal_wired_cap)."""
    local_vram = max(0, safe_int(local_node.get("vram_bytes"), 0))
    raw_ram = local_node.get("ram_effective_avail_bytes")
    local_ram = max(
        0, safe_int(raw_ram if raw_ram is not None else local_node.get("ram_available_bytes"), 0)
    )
    local_ram_total = max(0, safe_int(local_node.get("ram_total_bytes"), 0))
    local_unified = bool(local_node.get("is_unified_memory"))
    reserve_bytes = int(max(0.0, reserve_gib) * GIB)

    if local_unified:
        metal_cap = max(0, safe_int(local_node.get("metal_wired_limit_bytes"), 0))
        if metal_cap <= 0:
            metal_cap = int(local_ram_total * 0.70) if local_ram_total > 0 else local_ram
        fast_tier = max(0, min(local_ram, metal_cap) - reserve_bytes)
        ram_tier = max(0, local_ram - reserve_bytes - fast_tier)
        return True, fast_tier, ram_tier, metal_cap

    fast_tier = max(0, local_vram - int(0.5 * GIB))
    ram_tier = max(0, local_ram - reserve_bytes)
    return False, fast_tier, ram_tier, 0


def plan_cluster(params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
    """Compute adaptive tiered memory and optional GGML_RPC multi-node placement."""
    model = params.get("model") if isinstance(params.get("model"), dict) else {}
    local_node = params.get("local_node") if isinstance(params.get("local_node"), dict) else {}
    valid_workers = parse_valid_workers(params.get("workers"))
    storage = params.get("storage") if isinstance(params.get("storage"), dict) else {}
    raw_ctx = params.get("context_length")
    context_length = 4096 if raw_ctx is None else max(512, safe_int(raw_ctx, 4096))
    raw_res = params.get("safety_reserve_gib")
    reserve_gib = 2.0 if raw_res is None else max(0.0, safe_float(raw_res, 2.0))
    kv_cache_type = str(params.get("kv_cache_type") or "f16")

    weight_bytes, weight_notes, confidence = _estimate_weights(model)
    if weight_bytes is None:
        return {
            "value": {
                "strategy": "unavailable",
                "feasible": False,
                "tier1_gpu_bytes": 0,
                "tier2_ram_bytes": 0,
                "tier3_disk_mmap_bytes": 0,
                "node_allocations": [],
                "runtime_flags": [],
                "warnings": weight_notes,
            },
            "unit": "bytes",
            "source": "estimated",
            "confidence": "unknown",
            "limitations": weight_notes,
        }

    kv_bytes, kv_notes = _estimate_kv_cache(model, context_length, kv_cache_type=kv_cache_type)
    hot_bytes, expert_bytes, is_moe = _compute_hot_vs_expert_bytes(model, weight_bytes, kv_bytes)
    total_demand = hot_bytes + expert_bytes
    local_unified, local_fast_tier, local_ram_tier, metal_cap = _resolve_local_tiers(
        local_node, reserve_gib
    )
    local_total_budget = local_fast_tier + local_ram_tier
    warnings: list[str] = list(weight_notes + kv_notes)
    runtime_flags: list[str] = []

    if valid_workers and total_demand > local_total_budget:
        return build_multi_node_rpc_plan(
            local_node=local_node,
            local_total_budget=local_total_budget,
            local_fast_tier=local_fast_tier,
            local_unified=local_unified,
            valid_workers=valid_workers,
            total_demand=total_demand,
            hot_bytes=hot_bytes,
            is_moe=is_moe,
            confidence=confidence,
            warnings=warnings,
        )

    metal_cap_effective = max(metal_cap, local_fast_tier)
    should_offload_exps_cpu = (
        is_moe
        and expert_bytes > 0
        and (
            (not local_unified and total_demand > local_fast_tier)
            or (local_unified and total_demand > metal_cap_effective)
        )
    )

    if local_unified:
        if not should_offload_exps_cpu:
            tier1_gpu = min(total_demand, local_fast_tier)
            tier2_ram = min(max(0, total_demand - tier1_gpu), local_ram_tier)
        else:
            tier1_gpu = min(hot_bytes, local_fast_tier)
            effective_ram_pool = max(0, local_total_budget - tier1_gpu)
            tier2_ram = min(max(0, total_demand - tier1_gpu), effective_ram_pool)
        tier3_mmap = max(0, total_demand - tier1_gpu - tier2_ram)
    else:
        gpu_target = total_demand if not is_moe else hot_bytes
        tier1_gpu = min(gpu_target, local_fast_tier)
        remaining_after_gpu = max(0, total_demand - tier1_gpu)
        tier2_ram = min(remaining_after_gpu, local_ram_tier)
        tier3_mmap = max(0, remaining_after_gpu - tier2_ram)

    if should_offload_exps_cpu:
        runtime_flags.extend(["-ot", "exps=CPU", "-ngl", "999"])
        strategy = "single_node_moe_offload"
    elif tier3_mmap == 0:
        runtime_flags.extend(["-ngl", "999"])
        strategy = "single_node_full_fit"
    else:
        runtime_flags.extend(["--mmap"])
        strategy = "single_node_mmap_spill"

    media_kind = str(storage.get("media_kind") or "unknown").upper()
    if tier3_mmap > 0:
        warnings.append(
            f"{tier3_mmap / GIB:.1f} GiB exceeds local RAM/VRAM and must stream via "
            "external drive mmap."
        )
        if media_kind in {"HDD", "UNKNOWN"}:
            warnings.append(
                "External USB HDD / ExFAT mmap paging is slow for 70B-200B+ models; "
                "use an NVMe SSD or pool additional machines via GGML_RPC."
            )

    return {
        "value": {
            "strategy": strategy, "feasible": tier3_mmap == 0, "is_moe": is_moe,
            "total_demand_bytes": total_demand, "tier1_gpu_bytes": tier1_gpu,
            "tier2_ram_bytes": tier2_ram, "tier3_disk_mmap_bytes": tier3_mmap,
            "node_allocations": [{
                "name": local_node.get("name") or "local-host", "role": "standalone",
                "endpoint": "127.0.0.1", "allocated_bytes": tier1_gpu + tier2_ram,
                "budget_bytes": local_total_budget,
            }],
            "runtime_flags": runtime_flags, "warnings": warnings,
        },
        "unit": "bytes", "source": "calculated", "confidence": "medium", "limitations": warnings,
    }
