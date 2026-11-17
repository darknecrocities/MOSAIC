"""Adaptive 3-tier memory and multi-node RPC cluster planner for 70B-200B+ / MoE models."""

from __future__ import annotations

from typing import Any

from mosaic_analytics.model_fit_analyzer import GIB, _estimate_kv_cache, _estimate_weights
from mosaic_analytics.protocol import JobContext


def _compute_hot_vs_expert_bytes(
    model: dict[str, Any], weight_bytes: int, kv_bytes: int
) -> tuple[int, int, bool]:
    """Split weight footprint into always-active hot tensors vs routed MoE experts."""
    is_moe = bool(model.get("is_moe"))
    total_b = float(model.get("parameter_billions") or 0.0)
    active_b = float(model.get("active_parameter_billions") or 0.0)

    if is_moe and total_b > 0 and 0 < active_b < total_b:
        # Attention + embeddings + shared experts scale roughly with active ratio (floor 18%).
        hot_ratio = max(0.18, min(0.45, active_b / total_b))
        hot_weights = int(weight_bytes * hot_ratio)
        expert_weights = weight_bytes - hot_weights
        return hot_weights + kv_bytes, expert_weights, True

    return weight_bytes + kv_bytes, 0, False


def _node_budget_bytes(node: dict[str, Any], reserve_gib: float) -> int:
    """Usable memory budget for a local or remote RPC node."""
    is_unified = bool(node.get("is_unified_memory"))
    vram = int(node.get("vram_bytes") or 0)
    ram = int(node.get("ram_available_bytes") or 0)
    if is_unified:
        return max(0, ram - int(reserve_gib * GIB))
    if vram > 0:
        return max(0, vram - int(0.5 * GIB)) + max(0, ram - int(reserve_gib * GIB))
    return max(0, ram - int(reserve_gib * GIB))


def plan_cluster(params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
    """Compute adaptive tiered memory and optional GGML_RPC multi-node placement."""
    model = params.get("model") or {}
    local_node = params.get("local_node") or {}
    workers = list(params.get("workers") or [])
    storage = params.get("storage") or {}
    context_length = max(512, int(params.get("context_length") or 4096))
    reserve_gib = float(params.get("safety_reserve_gib") or 2.0)

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

    kv_bytes, kv_notes = _estimate_kv_cache(model, context_length)
    hot_bytes, expert_bytes, is_moe = _compute_hot_vs_expert_bytes(model, weight_bytes, kv_bytes)
    total_demand = hot_bytes + expert_bytes

    local_vram = int(local_node.get("vram_bytes") or 0)
    local_ram = int(local_node.get("ram_available_bytes") or 0)
    local_unified = bool(local_node.get("is_unified_memory"))
    local_fast_tier = (
        max(0, local_ram - int(reserve_gib * GIB))
        if local_unified
        else max(0, local_vram - int(0.5 * GIB))
    )
    local_ram_tier = 0 if local_unified else max(0, local_ram - int(reserve_gib * GIB))

    warnings: list[str] = list(weight_notes + kv_notes)
    runtime_flags: list[str] = []

    # 1. Evaluate multi-node GGML_RPC pooling when workers are configured and single-node is short.
    local_total_budget = local_fast_tier + local_ram_tier
    if workers and total_demand > local_total_budget:
        nodes = [
            {
                "name": local_node.get("name") or "local-coordinator",
                "role": "coordinator",
                "budget_bytes": local_total_budget,
                "endpoint": "127.0.0.1",
            }
        ]
        rpc_endpoints: list[str] = []
        for w in workers:
            budget = _node_budget_bytes(w, reserve_gib=1.0)
            host = str(w.get("host") or "")
            port = int(w.get("port") or 50052)
            if host and budget > 0:
                rpc_endpoints.append(f"{host}:{port}")
                nodes.append(
                    {
                        "name": w.get("name") or host,
                        "role": "rpc_worker",
                        "budget_bytes": budget,
                        "endpoint": f"{host}:{port}",
                    }
                )

        cluster_budget = sum(n["budget_bytes"] for n in nodes)
        if cluster_budget > 0:
            splits = [max(1, round((n["budget_bytes"] / cluster_budget) * 100)) for n in nodes]
            allocations = [
                {
                    "name": n["name"],
                    "role": n["role"],
                    "endpoint": n["endpoint"],
                    "allocated_bytes": int(total_demand * (n["budget_bytes"] / cluster_budget)),
                    "budget_bytes": n["budget_bytes"],
                }
                for n in nodes
            ]
            spill_bytes = max(0, total_demand - cluster_budget)
            if rpc_endpoints:
                runtime_flags.extend(
                    [
                        "--split-mode",
                        "layer",
                        "--rpc",
                        ",".join(rpc_endpoints),
                        "--tensor-split",
                        ",".join(str(s) for s in splits),
                    ]
                )
            if is_moe:
                runtime_flags.extend(["-ot", "exps=CPU"])
            if spill_bytes > 0:
                warnings.append(
                    f"Pooled cluster memory is short by {spill_bytes / GIB:.1f} GiB; "
                    "remaining weights would spill to external drive mmap."
                )
            warnings.append(
                "Cross-node GGML_RPC pools memory over TCP; token speed is bounded by network RTT."
            )
            tier1_gpu = min(hot_bytes, local_fast_tier)
            tier2_ram = max(0, min(total_demand - spill_bytes, cluster_budget) - tier1_gpu)
            return {
                "value": {
                    "strategy": "multi_node_rpc",
                    "feasible": spill_bytes == 0,
                    "is_moe": is_moe,
                    "total_demand_bytes": total_demand,
                    "tier1_gpu_bytes": tier1_gpu,
                    "tier2_ram_bytes": tier2_ram,
                    "tier3_disk_mmap_bytes": spill_bytes,
                    "node_allocations": allocations,
                    "runtime_flags": runtime_flags,
                    "warnings": warnings,
                },
                "unit": "bytes",
                "source": "calculated",
                "confidence": "medium" if confidence == "high" else confidence,
                "limitations": warnings,
            }

    # 2. Single-node adaptive 3-tier placement (GPU/Metal -> System RAM -> External Drive mmap)
    tier1_gpu = min(hot_bytes, local_fast_tier)
    remaining_after_gpu = max(0, total_demand - tier1_gpu)
    tier2_ram = min(remaining_after_gpu, local_ram_tier)
    tier3_mmap = max(0, remaining_after_gpu - tier2_ram)

    if is_moe and expert_bytes > 0:
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
            "strategy": strategy,
            "feasible": tier3_mmap == 0,
            "is_moe": is_moe,
            "total_demand_bytes": total_demand,
            "tier1_gpu_bytes": tier1_gpu,
            "tier2_ram_bytes": tier2_ram,
            "tier3_disk_mmap_bytes": tier3_mmap,
            "node_allocations": [
                {
                    "name": local_node.get("name") or "local-host",
                    "role": "standalone",
                    "endpoint": "127.0.0.1",
                    "allocated_bytes": tier1_gpu + tier2_ram,
                    "budget_bytes": local_total_budget,
                }
            ],
            "runtime_flags": runtime_flags,
            "warnings": warnings,
        },
        "unit": "bytes",
        "source": "calculated",
        "confidence": "medium",
        "limitations": warnings,
    }
