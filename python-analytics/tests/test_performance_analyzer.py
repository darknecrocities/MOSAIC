"""Unit tests for bottleneck diagnosis and efficiency analysis in performance_analyzer."""

from __future__ import annotations

import threading

from mosaic_analytics.model_fit_analyzer import GIB
from mosaic_analytics.performance_analyzer import analyze_performance
from mosaic_analytics.protocol import JobContext


def _ctx(job_id: str = "perf-1") -> JobContext:
    return JobContext(job_id=job_id, cancel_event=threading.Event())


def test_flags_hdd_and_cpu_bottlenecks() -> None:
    resp = analyze_performance(
        {
            "fit": {"fit_status": "Borderline", "expected_backend": "cpu_ram"},
            "storage": {"media_kind": "HDD"},
        },
        _ctx(),
    )
    cats = {b["category"] for b in resp["value"]["bottlenecks"]}
    assert {"memory_pressure", "compute_backend", "storage_throughput"} == cats


def test_healthy_ssd_gpu_report_has_no_bottlenecks() -> None:
    resp = analyze_performance(
        {
            "fit": {"fit_status": "Recommended", "expected_backend": "unified_metal"},
            "storage": {"media_kind": "SSD"},
            "system_profile": {"ram_total_bytes": 32 * GIB},
            "execution_plan": {"offload_ratio": 1.0, "kv_cache_type": "q8_0", "num_ctx": 8192},
            "report": {
                "cold_load_ms": 1800.0,
                "warm_load_ms": {"median": 450.0},
                "ttft_ms": {"median": 320.0},
                "generation_tok_per_sec": {"median": 48.0},
                "peak_ram_used_bytes": 12 * GIB,
                "context_length": 8192,
            },
        },
        _ctx("perf-ok"),
    )
    val = resp["value"]
    assert val["bottlenecks"] == []
    assert val["efficiency_ratios"]["cold_to_warm_load_ratio"] == 4.0
    assert val["efficiency_ratios"]["offload_ratio"] == 1.0


def test_report_detects_kv_pressure_partial_offload_and_prompt_latency() -> None:
    resp = analyze_performance(
        {
            "fit": {"fit_status": "Recommended", "expected_backend": "discrete_gpu"},
            "storage": {"media_kind": "SSD"},
            "system_profile": {"ram_total_bytes": 16 * GIB},
            "execution_plan": {"offload_ratio": 0.65, "kv_cache_type": "f16", "num_ctx": 8192},
            "report": {
                "cold_load_ms": 22_000.0,
                "warm_load_ms": {"median": 1_000.0},
                "ttft_ms": {"median": 4_200.0},
                "generation_tok_per_sec": {"median": 3.8},
                "peak_ram_used_bytes": 13 * GIB,
                "context_length": 8192,
            },
        },
        _ctx("perf-warn"),
    )
    cats = {b["category"] for b in resp["value"]["bottlenecks"]}
    assert {
        "storage_throughput",
        "partial_offload",
        "prompt_eval_latency",
        "kv_cache_pressure",
    }.issubset(cats)
    assert len(resp["value"]["recommendations"]) >= 3
