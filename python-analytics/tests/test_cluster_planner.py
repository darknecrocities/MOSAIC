"""Unit tests for adaptive 3-tier MoE and multi-node GGML_RPC cluster planning."""

from __future__ import annotations

import threading

from mosaic_analytics.cluster_planner import plan_cluster
from mosaic_analytics.model_fit_analyzer import GIB
from mosaic_analytics.protocol import JobContext


def _ctx() -> JobContext:
    return JobContext(job_id="cluster-1", cancel_event=threading.Event())


def test_200b_moe_generates_exps_cpu_and_mmap_spill_on_small_laptop() -> None:
    res = plan_cluster(
        {
            "model": {
                "download_size_bytes": 115 * GIB,
                "parameter_billions": 235.0,
                "active_parameter_billions": 22.0,
                "is_moe": True,
                "n_layers": 94,
                "n_kv_heads": 4,
                "head_dim": 128,
            },
            "local_node": {
                "name": "Apple M3",
                "is_unified_memory": True,
                "ram_available_bytes": 12 * GIB,
            },
            "storage": {"media_kind": "HDD"},
            "context_length": 4096,
            "safety_reserve_gib": 2.0,
        },
        _ctx(),
    )
    val = res["value"]
    assert val["strategy"] == "single_node_moe_offload"
    assert val["is_moe"] is True
    assert "exps=CPU" in val["runtime_flags"]
    assert val["tier3_disk_mmap_bytes"] > 0
    assert any("NVMe SSD" in w for w in val["warnings"])


def test_70b_dense_pools_memory_across_three_rpc_nodes() -> None:
    res = plan_cluster(
        {
            "model": {
                "download_size_bytes": 40 * GIB,
                "parameter_billions": 70.0,
                "is_moe": False,
                "n_layers": 80,
                "n_kv_heads": 8,
                "head_dim": 128,
            },
            "local_node": {
                "name": "Apple M3",
                "is_unified_memory": True,
                "ram_available_bytes": 12 * GIB,
            },
            "workers": [
                {
                    "name": "Win-RTX4090",
                    "host": "192.168.1.50",
                    "port": 50052,
                    "vram_bytes": 24 * GIB,
                    "ram_available_bytes": 16 * GIB,
                },
                {
                    "name": "Linux-Rig",
                    "host": "192.168.1.51",
                    "port": 50052,
                    "vram_bytes": 0,
                    "ram_available_bytes": 32 * GIB,
                },
            ],
            "context_length": 4096,
            "safety_reserve_gib": 2.0,
        },
        _ctx(),
    )
    val = res["value"]
    assert val["strategy"] == "multi_node_rpc"
    assert val["feasible"] is True
    assert val["tier3_disk_mmap_bytes"] == 0
    assert len(val["node_allocations"]) == 3
    assert "--rpc" in val["runtime_flags"]
    assert "192.168.1.50:50052,192.168.1.51:50052" in val["runtime_flags"]


def test_unified_memory_30b_moe_within_metal_cap_omits_exps_cpu(qwen3_30b_iq2) -> None:
    res = plan_cluster(
        {
            "model": qwen3_30b_iq2,
            "local_node": {
                "name": "Apple M3",
                "is_unified_memory": True,
                "ram_total_bytes": 16 * GIB,
                "ram_available_bytes": 13 * GIB,
                "metal_wired_limit_bytes": int(11.5 * GIB),
            },
            "context_length": 4096,
            "safety_reserve_gib": 1.5,
            "kv_cache_type": "q8_0",
        },
        _ctx(),
    )
    val = res["value"]
    assert val["strategy"] == "single_node_full_fit"
    assert val["feasible"] is True
    assert "exps=CPU" not in val["runtime_flags"]
    assert "-ngl" in val["runtime_flags"]


def test_unified_memory_moe_exceeding_metal_cap_emits_exps_cpu(qwen3_30b_iq3) -> None:
    res = plan_cluster(
        {
            "model": qwen3_30b_iq3,
            "local_node": {
                "name": "Apple M3",
                "is_unified_memory": True,
                "ram_total_bytes": 16 * GIB,
                "ram_available_bytes": 13 * GIB,
                "metal_wired_limit_bytes": 10 * GIB,
            },
            "context_length": 4096,
            "safety_reserve_gib": 2.0,
        },
        _ctx(),
    )
    val = res["value"]
    assert val["strategy"] == "single_node_moe_offload"
    assert "exps=CPU" in val["runtime_flags"]


def test_discrete_gpu_moe_exceeding_vram_emits_exps_cpu(qwen3_30b_q4) -> None:
    res = plan_cluster(
        {
            "model": qwen3_30b_q4,
            "local_node": {
                "name": "Win-8GB",
                "is_unified_memory": False,
                "vram_bytes": 8 * GIB,
                "ram_available_bytes": 32 * GIB,
            },
            "context_length": 4096,
            "safety_reserve_gib": 2.0,
        },
        _ctx(),
    )
    val = res["value"]
    assert val["strategy"] == "single_node_moe_offload"
    assert val["feasible"] is True
    assert "exps=CPU" in val["runtime_flags"]


def test_unified_memory_16gb_within_total_ram_and_metal_cap_full_fit(qwen3_30b_iq2) -> None:
    val = plan_cluster(
        {
            "model": qwen3_30b_iq2,
            "local_node": {
                "name": "M3",
                "is_unified_memory": True,
                "ram_total_bytes": 16 * GIB,
                "ram_available_bytes": 13 * GIB,
            },
            "context_length": 16384,
            "kv_cache_type": "f16",
            "safety_reserve_gib": 2.0,
        },
        _ctx(),
    )["value"]
    assert val["strategy"] == "single_node_full_fit"
    assert val["feasible"] is True
    assert val["tier3_disk_mmap_bytes"] == 0
    assert val["runtime_flags"] == ["-ngl", "999"]


def test_unified_memory_24gb_30b_moe_conserves_full_ram_budget(qwen3_30b_q4) -> None:
    val = plan_cluster(
        {
            "model": qwen3_30b_q4,
            "local_node": {
                "name": "M3-24G",
                "is_unified_memory": True,
                "ram_total_bytes": 24 * GIB,
                "ram_effective_avail_bytes": 21 * GIB,
                "metal_wired_limit_bytes": int(16.8 * GIB),
            },
            "context_length": 4096,
            "safety_reserve_gib": 2.0,
        },
        _ctx(),
    )["value"]
    assert val["strategy"] == "single_node_moe_offload"
    assert val["feasible"] is True
    assert val["tier3_disk_mmap_bytes"] == 0
    assert val["tier1_gpu_bytes"] + val["tier2_ram_bytes"] == val["total_demand_bytes"]


def test_zero_valid_and_malformed_workers_fall_back_to_single_node(qwen3_30b_q4) -> None:
    val = plan_cluster(
        {
            "model": qwen3_30b_q4,
            "local_node": {
                "name": "M3",
                "is_unified_memory": True,
                "ram_total_bytes": 16 * GIB,
                "ram_available_bytes": 10 * GIB,
            },
            "workers": [
                "10.0.0.2:50052",
                {"name": "no-host", "ram_available_bytes": 32 * GIB},
                {"host": "10.0.0.2", "port": -1, "ram_available_bytes": 32 * GIB},
                {"host": "10.0.0.2", "port": "bad", "ram_available_bytes": 32 * GIB},
                {"host": "10.0.0.2", "port": 70000, "ram_available_bytes": 32 * GIB},
                {"host": "10.0.0.2", "port": 50052, "ram_available_bytes": 0},
            ],
        },
        _ctx(),
    )["value"]
    assert val["strategy"] != "multi_node_rpc"
    assert len(val["runtime_flags"]) > 0


def test_discrete_24gb_vram_16gb_ram_30b_moe_fits_fully_in_vram(qwen3_30b_q4) -> None:
    val = plan_cluster(
        {
            "model": qwen3_30b_q4,
            "local_node": {
                "name": "Win-24GB",
                "is_unified_memory": False,
                "vram_bytes": 24 * GIB,
                "ram_available_bytes": 16 * GIB,
                "ram_total_bytes": 16 * GIB,
            },
            "context_length": 4096,
            "safety_reserve_gib": 2.0,
        },
        _ctx(),
    )["value"]
    assert val["strategy"] == "single_node_full_fit"
    assert val["feasible"] is True
    assert val["tier1_gpu_bytes"] == val["total_demand_bytes"]
    assert val["tier2_ram_bytes"] == 0
    assert val["tier3_disk_mmap_bytes"] == 0
    assert val["runtime_flags"] == ["-ngl", "999"]
