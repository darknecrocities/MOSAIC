"""Constrained-memory, Metal wired cap, hybrid VRAM/RAM offload, and profile tests."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from mosaic_analytics import execution_planner
from mosaic_analytics.model_fit_analyzer import GIB, assess_model_fit


def test_8gb_cpu_only_fits_1b_and_rejects_30b(cpu_8gb, qwen3_30b_iq2, make_ctx) -> None:
    small_res = assess_model_fit(
        {
            "model": {
                "download_size_bytes": int(1.2 * GIB),
                "parameter_billions": 1.24,
                "n_layers": 16,
                "n_kv_heads": 8,
                "head_dim": 64,
            },
            "hardware": cpu_8gb,
            "context_length": 4096,
        },
        make_ctx("cpu-small"),
    )["value"]
    large_res = assess_model_fit(
        {"model": qwen3_30b_iq2, "hardware": cpu_8gb, "context_length": 4096},
        make_ctx("cpu-30b"),
    )["value"]

    assert small_res["expected_backend"] == "cpu_ram"
    assert small_res["fit_status"] == "Recommended"
    assert small_res["execution_plan"]["num_gpu"] == 0
    assert large_res["fit_status"] == "Not recommended"


def test_apple_16gb_metal_wired_cap_and_70pct_fallback(apple_16gb, qwen3_30b_iq2, make_ctx) -> None:
    capped = assess_model_fit(
        {
            "model": qwen3_30b_iq2,
            "hardware": {**apple_16gb, "metal_wired_limit_bytes": int(10.5 * GIB)},
            "context_length": 4096,
            "safety_reserve_gib": 2.0,
        },
        make_ctx("metal-cap"),
    )["value"]
    fallback = assess_model_fit(
        {
            "model": qwen3_30b_iq2,
            "hardware": apple_16gb,
            "context_length": 4096,
            "safety_reserve_gib": 2.0,
        },
        make_ctx("metal-fallback"),
    )["value"]

    assert capped["available_budget"] == int(10.5 * GIB) - 2 * GIB
    assert fallback["available_budget"] == int(16 * GIB * 0.70) - 2 * GIB
    assert capped["cpu_spill_budget_bytes"] > 0


def test_ram_effective_avail_handles_psutil_flag_deterministically(monkeypatch) -> None:
    monkeypatch.setattr(
        execution_planner.psutil,
        "virtual_memory",
        lambda: SimpleNamespace(total=16 * GIB, available=10 * GIB),
    )
    deterministic = execution_planner.resolve_effective_ram_avail(
        {"ram_total_bytes": 16 * GIB, "ram_available_bytes": 2 * GIB}
    )
    probed = execution_planner.resolve_effective_ram_avail(
        {"ram_total_bytes": 16 * GIB, "ram_available_bytes": 2 * GIB, "probe_psutil": True}
    )
    assert deterministic == 2 * GIB
    assert probed == 10 * GIB


def test_qwen3_30b_quant_progression_on_16gb_apple_silicon(
    apple_16gb, qwen3_30b_iq2, qwen3_30b_iq3, qwen3_30b_q4, make_ctx
) -> None:
    common = {"hardware": apple_16gb, "context_length": 4096, "safety_reserve_gib": 1.5}
    iq2 = assess_model_fit({"model": qwen3_30b_iq2, **common}, make_ctx("iq2"))["value"]
    iq3 = assess_model_fit({"model": qwen3_30b_iq3, **common}, make_ctx("iq3"))["value"]
    q4 = assess_model_fit({"model": qwen3_30b_q4, **common}, make_ctx("q4"))["value"]

    assert iq2["fit_status"] in {"Recommended", "Borderline"}
    assert iq2["total_estimated_bytes"] < iq3["total_estimated_bytes"] < q4["total_estimated_bytes"]
    assert q4["fit_status"] == "Not recommended"


def test_discrete_8gb_vram_16gb_ram_hybrid_layer_offload(
    discrete_8gb, qwen3_30b_iq2, make_ctx
) -> None:
    fit_8b = assess_model_fit(
        {
            "model": {
                "download_size_bytes": 4_920_000_000,
                "parameter_billions": 8.0,
                "n_layers": 32,
                "n_kv_heads": 8,
                "head_dim": 128,
            },
            "hardware": discrete_8gb,
            "context_length": 4096,
        },
        make_ctx("dgpu-8b"),
    )["value"]
    fit_30b = assess_model_fit(
        {"model": qwen3_30b_iq2, "hardware": discrete_8gb, "context_length": 4096},
        make_ctx("dgpu-30b"),
    )["value"]

    assert fit_8b["execution_plan"]["num_gpu"] == 999
    assert fit_8b["execution_plan"]["offload_ratio"] == 1.0
    assert fit_30b["fit_status"] == "Borderline"
    assert 0 < fit_30b["execution_plan"]["num_gpu"] < 48
    assert 0.0 < fit_30b["execution_plan"]["offload_ratio"] < 1.0


@pytest.mark.parametrize(
    ("profile", "expected_kv", "max_batch"),
    [
        ("constrained_memory", "q4_0", 128),
        ("balanced", "q8_0", 256),
        ("max_quality", "f16", 512),
        ("auto_adaptive", "f16", 512),
    ],
)
def test_execution_profiles_and_hdd_warnings(
    profile: str, expected_kv: str, max_batch: int, qwen3_30b_iq2, make_ctx
) -> None:
    res = assess_model_fit(
        {
            "model": {
                "download_size_bytes": 4_500_000_000,
                "parameter_billions": 8.0,
                "n_layers": 32,
                "n_kv_heads": 8,
                "head_dim": 128,
            },
            "hardware": {
                "is_unified_memory": True,
                "ram_total_bytes": 32 * GIB,
                "ram_available_bytes": 28 * GIB,
                "physical_cores": 10,
            },
            "storage": {"media_kind": "HDD"},
            "context_length": 8192,
            "execution_profile": profile,
        },
        make_ctx(f"prof-{profile}"),
    )["value"]
    plan = res["execution_plan"]
    assert plan["kv_cache_type"] == expected_kv
    assert plan["num_batch"] <= max_batch
    assert plan["num_thread"] == 10
    assert plan["use_mmap"] is True
    assert any("HDD" in r for r in res["reasons"])

    spill = assess_model_fit(
        {
            "model": qwen3_30b_iq2,
            "hardware": {
                "is_unified_memory": False,
                "gpu_vram_bytes": 8 * GIB,
                "ram_total_bytes": 16 * GIB,
                "ram_available_bytes": 14 * GIB,
            },
            "storage": {"media_kind": "HDD"},
            "context_length": 4096,
            "execution_profile": "constrained_memory",
        },
        make_ctx("hdd-spill"),
    )["value"]
    assert spill["execution_plan"]["use_mlock"] is False
    assert any("HDD" in w for w in spill["execution_plan"]["warnings"])
