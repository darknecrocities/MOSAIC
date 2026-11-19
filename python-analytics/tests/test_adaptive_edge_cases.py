"""Regression tests for execution_planner and model_fit_analyzer edge cases."""

from __future__ import annotations

from mosaic_analytics.fit_inputs import is_pos_num
from mosaic_analytics.model_fit_analyzer import GIB, assess_model_fit, assess_model_fit_batch
from mosaic_analytics.numeric import safe_float, safe_int, safe_optional_float


def test_stepped_down_plan_ctx_keeps_num_gpu_and_fit_consistent_16gb_14b(make_ctx) -> None:
    res = assess_model_fit(
        {
            "model": {
                "download_size_bytes": 8_990_000_000,
                "n_layers": 48,
                "n_kv_heads": 8,
                "head_dim": 128,
            },
            "hardware": {
                "is_unified_memory": True,
                "ram_total_bytes": 16 * GIB,
                "ram_available_bytes": 13 * GIB,
                "physical_cores": 8,
            },
            "context_length": 32768,
            "execution_profile": "auto_adaptive",
        },
        make_ctx("stepdown-14b"),
    )["value"]
    plan = res["execution_plan"]
    assert plan["num_ctx"] == 8192
    assert res["context_length"] == 8192
    assert res["requested_context_length"] == 32768
    assert plan["num_gpu"] > 0
    assert plan["offload_ratio"] > 0.0
    assert not any("disk mmap" in w for w in plan["warnings"])
    assert not any("HDD" in w for w in plan["warnings"])
    assert any("Context auto-adjusted from 32768 to 8192" in r for r in res["reasons"])


def test_stepped_down_plan_ctx_8b_131k_consistent_recommended(make_ctx) -> None:
    res = assess_model_fit(
        {
            "model": {
                "download_size_bytes": 4_920_000_000,
                "n_layers": 32,
                "n_kv_heads": 8,
                "head_dim": 128,
            },
            "hardware": {
                "is_unified_memory": True,
                "ram_total_bytes": 16 * GIB,
                "ram_available_bytes": 11 * GIB,
                "metal_wired_limit_bytes": 11_456_825_262,
                "physical_cores": 8,
            },
            "context_length": 131072,
            "execution_profile": "auto_adaptive",
        },
        make_ctx("stepdown-8b"),
    )["value"]
    assert res["execution_plan"]["num_ctx"] == 8192
    assert res["context_length"] == 8192
    assert res["requested_context_length"] == 131072
    assert res["execution_plan"]["num_gpu"] == 999
    assert res["fit_status"] == "Recommended"
    assert res["execution_plan"]["warnings"] == []


def test_system_profile_forwards_psutil_available_bytes(make_ctx) -> None:
    batch = assess_model_fit_batch(
        {
            "system_profile": {
                "is_unified_memory": True,
                "ram_total_bytes": 16 * GIB,
                "ram_available_bytes": int(0.71 * GIB),
                "psutil_available_bytes": int(4.72 * GIB),
            },
            "models": [
                {
                    "ollama_name": "qwen2.5:0.5b",
                    "download_size_bytes": 397_000_000,
                    "n_layers": 24,
                    "n_kv_heads": 2,
                    "head_dim": 64,
                }
            ],
            "media_kind": "SSD",
        },
        make_ctx("sysprof-psutil"),
    )["value"]["assessments"][0]
    assert batch["available_budget"] > 2 * GIB
    assert batch["fit_status"] == "Recommended"


def test_unknown_media_kind_emits_no_false_hdd_warning(qwen3_30b_q4, make_ctx) -> None:
    res = assess_model_fit(
        {
            "model": qwen3_30b_q4,
            "hardware": {
                "is_unified_memory": True,
                "ram_total_bytes": 16 * GIB,
                "ram_available_bytes": 13 * GIB,
            },
            "context_length": 4096,
        },
        make_ctx("unknown-media"),
    )["value"]
    assert not any("HDD" in w for w in res["execution_plan"]["warnings"])


def test_zero_reserve_zero_ctx_and_num_parallel(make_ctx) -> None:
    model = {
        "download_size_bytes": int(4.0 * GIB),
        "n_layers": 32,
        "n_kv_heads": 8,
        "head_dim": 128,
    }
    hw = {"is_unified_memory": False, "ram_total_bytes": 10 * GIB, "ram_available_bytes": 10 * GIB}
    r1 = assess_model_fit(
        {"model": model, "hardware": hw, "safety_reserve_gib": 0.0, "context_length": 0},
        make_ctx("zero-vals"),
    )["value"]
    r2 = assess_model_fit(
        {
            "model": model,
            "hardware": hw,
            "safety_reserve_gib": 0.0,
            "context_length": 0,
            "num_parallel": 2,
        },
        make_ctx("par-2"),
    )["value"]
    assert r1["available_budget"] == 10 * GIB
    assert r1["context_length"] == 512
    assert r1["execution_plan"]["num_ctx"] == 512
    assert r2["execution_plan"]["num_parallel"] == 2
    assert r2["kv_cache_estimate"] == r1["kv_cache_estimate"] * 2


def test_bool_float_vram_and_bad_string_inputs(make_ctx) -> None:
    model = {
        "download_size_bytes": 4_000_000_000,
        "n_layers": "bad",
        "n_kv_heads": 8,
        "head_dim": 128,
    }
    res_bool = assess_model_fit(
        {
            "model": {**model, "download_size_bytes": True},
            "hardware": {
                "is_unified_memory": False,
                "gpu_vram_bytes": True,
                "ram_available_bytes": 16 * GIB,
            },
            "context_length": "bad",
            "safety_reserve_gib": "bad",
        },
        make_ctx("bool-bad"),
    )["value"]
    assert res_bool["fit_status"] == "Unknown"

    res_cpu = assess_model_fit(
        {
            "model": model,
            "hardware": {
                "is_unified_memory": False,
                "gpu_vram_bytes": True,
                "ram_available_bytes": 16 * GIB,
            },
            "context_length": "bad",
        },
        make_ctx("bool-vram"),
    )["value"]
    assert res_cpu["expected_backend"] == "cpu_ram"

    res_flt = assess_model_fit(
        {
            "model": model,
            "hardware": {
                "is_unified_memory": False,
                "gpu_vram_bytes": float(8 * GIB),
                "ram_available_bytes": 16 * GIB,
            },
        },
        make_ctx("float-vram"),
    )["value"]
    assert res_flt["expected_backend"] == "discrete_gpu"


def test_numeric_overflow_huge_int_and_scalar_gpus(make_ctx) -> None:
    huge = 10**400
    assert safe_optional_float(huge) is None
    assert safe_float(huge, 1.5) == 1.5
    assert safe_int(huge, 7) == 7
    assert is_pos_num(huge) is False

    res = assess_model_fit(
        {
            "model": {"download_size_bytes": huge, "parameter_billions": huge},
            "system_profile": {
                "is_unified_memory": False,
                "gpus": 123,
                "gpu_vram_bytes": huge,
                "ram_available_bytes": 16 * GIB,
            },
            "safety_reserve_gib": huge,
            "context_length": huge,
        },
        make_ctx("huge-int"),
    )["value"]
    assert res["fit_status"] == "Unknown"

    batch = assess_model_fit_batch(
        {
            "system_profile": {"gpus": "bad", "ram_available_bytes": 16 * GIB},
            "models": [{"ollama_name": "qwen2.5:0.5b", "download_size_bytes": 400_000_000}],
        },
        make_ctx("scalar-gpus"),
    )["value"]["assessments"][0]
    assert batch["fit_status"] == "Recommended"
    assert batch["expected_backend"] == "cpu_ram"
