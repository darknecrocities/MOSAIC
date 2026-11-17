"""Unit tests for model_fit_analyzer across Apple Silicon, low-RAM, and GPU fixtures."""

from __future__ import annotations

import threading

from mosaic_analytics.model_fit_analyzer import GIB, assess_model_fit
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
