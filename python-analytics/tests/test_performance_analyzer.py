"""Unit tests for bottleneck diagnosis and efficiency analysis in performance_analyzer."""

from __future__ import annotations

import threading
from typing import Any

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


def test_analyze_performance_guards_non_numeric_and_malformed_inputs() -> None:
    resp = analyze_performance(
        {
            "fit": "bad",
            "storage": "bad",
            "system_profile": {"ram_total_bytes": "bad"},
            "execution_plan": {"offload_ratio": True, "num_ctx": "bad"},
            "report": {
                "cold_load_ms": "not_a_float",
                "warm_load_ms": {"median": "oops"},
                "ttft_ms": float("inf"),
                "generation_tok_per_sec": True,
                "peak_ram_used_bytes": "bad",
                "context_length": "bad",
            },
        },
        _ctx("perf-bad"),
    )
    val = resp["value"]
    assert val["summary"] == "No major hardware bottlenecks detected."
    assert val["efficiency_ratios"]["cold_to_warm_load_ratio"] is None
    assert val["efficiency_ratios"]["offload_ratio"] is None


def test_constrained_q4_kv_16gb_benchmark_avoids_false_kv_cache_pressure(monkeypatch) -> None:
    from mosaic_analytics import benchmark_runner

    def fake_post(_url: str, payload: dict[str, Any], timeout_s: float = 60.0) -> dict[str, Any]:
        if payload.get("keep_alive") == 0:
            return {"done": True}
        return {
            "done": True,
            "load_duration": 186_571_730_000,
            "prompt_eval_duration": 256_970_000,
            "eval_duration": 1_000_000_000,
            "eval_count": 33,
        }

    monkeypatch.setattr(benchmark_runner, "_post_json", fake_post)
    bench = benchmark_runner.run_benchmark(
        {
            "endpoint": "http://127.0.0.1:11434",
            "model": "hf.co/bartowski/Qwen_Qwen3-30B-A3B-GGUF:IQ2_XS",
            "repetitions": 2,
            "context_length": 4096,
            "execution_profile": "constrained_memory",
            "kv_cache_type": "q4_0",
            "offload_ratio": 1.0,
        },
        _ctx("bench-ch1"),
    )["value"]
    bench["peak_ram_used_bytes"] = 12_534_431_744

    perf = analyze_performance(
        {
            "report": bench,
            "system_profile": {"ram_total_bytes": 16 * GIB},
            "storage": {"media_kind": "SSD"},
            "execution_plan": bench["applied_options"],
        },
        _ctx("perf-ch1"),
    )["value"]
    cats = {b["category"] for b in perf["bottlenecks"]}
    assert "kv_cache_pressure" not in cats
    assert perf["efficiency_ratios"]["memory_utilization_ratio"] == 0.73
    assert perf["efficiency_ratios"]["offload_ratio"] == 1.0
