"""Unit tests for model_fit_analyzer across Apple Silicon, GPU, KV-quant, and batch fit."""

from __future__ import annotations

import threading

from mosaic_analytics.model_fit_analyzer import (
    GIB,
    QUANT_BPW,
    _estimate_weights,
    assess_model_fit,
    assess_model_fit_batch,
)
from mosaic_analytics.protocol import JobContext


def _ctx() -> JobContext:
    return JobContext(job_id="fit-1", cancel_event=threading.Event())


def test_small_model_recommended_on_apple_silicon_16gb() -> None:
    resp = assess_model_fit(
        {
            "model": {
                "download_size_bytes": int(1.3 * GIB),
                "parameter_billions": 1.0,
                "quantization": "Q4_K_M",
                "n_layers": 16,
                "n_kv_heads": 8,
                "head_dim": 64,
            },
            "hardware": {
                "is_unified_memory": True,
                "ram_total_bytes": 16 * GIB,
                "ram_available_bytes": 9 * GIB,
            },
            "storage": {"media_kind": "SSD"},
            "context_length": 4096,
            "safety_reserve_gib": 2.0,
        },
        _ctx(),
    )
    assert resp["value"]["fit_status"] == "Recommended"
    assert resp["value"]["expected_backend"] == "unified_metal"
    assert resp["value"]["performance_estimate"] == "Not benchmarked yet"


def test_large_70b_not_recommended_on_16gb_host() -> None:
    resp = assess_model_fit(
        {
            "model": {
                "download_size_bytes": 40 * GIB,
                "parameter_billions": 70.0,
                "quantization": "Q4_K_M",
                "n_layers": 80,
                "n_kv_heads": 8,
                "head_dim": 128,
            },
            "hardware": {
                "is_unified_memory": True,
                "ram_total_bytes": 16 * GIB,
                "ram_available_bytes": 10 * GIB,
            },
            "context_length": 4096,
        },
        _ctx(),
    )
    assert resp["value"]["fit_status"] == "Not recommended"


def test_kv_cache_scales_with_context_length() -> None:
    base_params = {
        "model": {
            "download_size_bytes": int(4.7 * GIB),
            "n_layers": 32,
            "n_kv_heads": 8,
            "head_dim": 128,
        },
        "hardware": {
            "is_unified_memory": False,
            "gpu_vram_bytes": 24 * GIB,
            "ram_available_bytes": 32 * GIB,
        },
    }
    short_ctx = assess_model_fit({**base_params, "context_length": 4096}, _ctx())
    long_ctx = assess_model_fit({**base_params, "context_length": 32768}, _ctx())
    assert long_ctx["value"]["kv_cache_estimate"] == short_ctx["value"]["kv_cache_estimate"] * 8


def test_missing_metadata_returns_unknown() -> None:
    resp = assess_model_fit({"model": {}, "hardware": {}}, _ctx())
    assert resp["value"]["fit_status"] == "Unknown"


def test_quant_bpw_ordering_and_param_fallback() -> None:
    ordered = [
        "IQ2_XS",
        "Q2_K",
        "IQ3_XXS",
        "Q3_K_S",
        "IQ3_M",
        "Q3_K_M",
        "Q3_K_L",
        "IQ4_XS",
        "Q4_0",
        "Q4_K_M",
        "Q5_K_S",
        "Q5_K_M",
        "Q6_K",
        "Q8_0",
        "FP16",
    ]
    bpws = [QUANT_BPW[q] for q in ordered]
    assert all(b > 0 for b in bpws)
    assert bpws == sorted(bpws)

    w_iq2, _, conf = _estimate_weights({"parameter_billions": 30.0, "quantization": "iq2_xs"})
    w_q4, _, _ = _estimate_weights({"parameter_billions": 30.0, "quantization": "Q4_K_M"})
    assert conf == "medium"
    assert w_iq2 is not None and w_q4 is not None and w_iq2 < w_q4


def test_kv_cache_quantization_ratios_and_flash_attention(apple_16gb, qwen3_30b_iq2) -> None:
    base = {
        "model": qwen3_30b_iq2,
        "hardware": apple_16gb,
        "context_length": 16384,
        "safety_reserve_gib": 1.5,
    }
    f16 = assess_model_fit({**base, "kv_cache_type": "f16"}, _ctx())["value"]
    q8 = assess_model_fit({**base, "kv_cache_type": "q8_0"}, _ctx())["value"]
    q4 = assess_model_fit({**base, "kv_cache_type": "q4_0"}, _ctx())["value"]

    assert q8["kv_cache_estimate"] == f16["kv_cache_estimate"] // 2
    assert q4["kv_cache_estimate"] == f16["kv_cache_estimate"] // 4
    assert q4["execution_plan"]["flash_attention"] is True
    assert q4["execution_plan"]["num_parallel"] == 1


def test_estimate_fit_batch_matches_single_assessments(apple_16gb, qwen3_30b_iq2) -> None:
    models = [
        {
            "ollama_name": "qwen2.5:0.5b",
            "download_size_bytes": 397_000_000,
            "n_layers": 24,
            "n_kv_heads": 2,
            "head_dim": 64,
        },
        qwen3_30b_iq2,
        {
            "ollama_name": "deepseek-r1:70b",
            "download_size_bytes": 42_520_000_000,
            "n_layers": 80,
            "n_kv_heads": 8,
            "head_dim": 128,
        },
        {"ollama_name": "broken-entry"},
    ]
    batch = assess_model_fit_batch(
        {
            "system_profile": apple_16gb,
            "models": models,
            "context_length": 4096,
            "safety_reserve_gib": 2.0,
            "media_kind": "SSD",
        },
        _ctx(),
    )
    items = batch["value"]["assessments"]
    assert [it["model_id"] for it in items] == [m["ollama_name"] for m in models]
    assert items[-1]["fit_status"] == "Unknown"

    for model, item in zip(models[:3], items[:3], strict=True):
        single = assess_model_fit(
            {
                "model": model,
                "hardware": apple_16gb,
                "storage": {"media_kind": "SSD"},
                "context_length": 4096,
                "safety_reserve_gib": 2.0,
            },
            _ctx(),
        )["value"]
        assert item["fit_status"] == single["fit_status"]
        assert item["weight_memory_estimate"] == single["weight_memory_estimate"]
        assert item["kv_cache_estimate"] == single["kv_cache_estimate"]
        assert item["execution_plan"] == single["execution_plan"]


def test_estimate_fit_batch_empty_and_cancelled(apple_16gb, qwen3_30b_iq2) -> None:
    empty = assess_model_fit_batch({"system_profile": apple_16gb, "models": []}, _ctx())
    assert empty["value"]["assessments"] == []

    cancel_ev = threading.Event()
    cancel_ev.set()
    cancelled = assess_model_fit_batch(
        {"system_profile": apple_16gb, "models": [qwen3_30b_iq2]},
        JobContext(job_id="fit-cancel", cancel_event=cancel_ev),
    )
    assert cancelled["value"]["cancelled"] is True
    assert cancelled["value"]["assessments"] == []
