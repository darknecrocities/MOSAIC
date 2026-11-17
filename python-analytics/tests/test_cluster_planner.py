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
