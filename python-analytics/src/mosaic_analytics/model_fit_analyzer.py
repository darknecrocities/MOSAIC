"""Hardware-aware model-fit, KV-cache quantization, and batch assessment engine."""

from __future__ import annotations

from typing import Any

from mosaic_analytics.execution_planner import (
    GIB,
    HardwareMemoryBudget,
    compute_execution_plan,
    normalize_profile,
    resolve_kv_cache_type,
    resolve_memory_budget,
)
from mosaic_analytics.protocol import JobContext

QUANT_BPW: dict[str, float] = {
    "IQ2_XS": 2.38, "Q2_K": 3.1, "IQ3_XXS": 3.12, "Q3_K_S": 3.50,
    "IQ3_M": 3.70, "Q3_K_M": 3.9, "Q3_K_L": 4.10, "IQ4_XS": 4.28,
    "Q4_0": 4.5, "Q4_K_M": 4.85, "Q5_K_S": 5.50, "Q5_K_M": 5.7,
    "Q6_K": 6.6, "Q8_0": 8.5, "FP16": 16.0,
}

KV_BYTES_PER_ELEM: dict[str, float] = {"f16": 2.0, "q8_0": 1.0, "q4_0": 0.5}


def _estimate_weights(model: dict[str, Any]) -> tuple[int | None, list[str], str]:
    """Estimate runtime weight memory in bytes from exact size or parameter count."""
    size_bytes = model.get("download_size_bytes") or model.get("estimated_bytes")
    if isinstance(size_bytes, int | float) and size_bytes > 0:
        return int(size_bytes * 1.03), [], "high"

    params_b = model.get("parameter_billions") or model.get("params_b")
    quant = str(model.get("quantization") or "Q4_K_M").upper()
    if isinstance(params_b, int | float) and params_b > 0:
        bpw = QUANT_BPW.get(quant, 4.85)
        estimated = int(params_b * 1e9 * (bpw / 8.0) * 1.05)
        notes = [f"Weight memory estimated from {params_b}B params at {quant} ({bpw} bpw)."]
        return estimated, notes, "medium"

    return None, ["Insufficient model weight or parameter metadata."], "unknown"


def _estimate_kv_cache(
    model: dict[str, Any],
    context_length: int,
    kv_cache_type: str = "f16",
    num_parallel: int = 1,
) -> tuple[int, list[str]]:
    """Compute KV cache bytes using GQA head dimensions and KV quantization."""
    kv_bpe = KV_BYTES_PER_ELEM.get(str(kv_cache_type or "f16").lower(), 2.0)
    slots = max(1, int(num_parallel))
    n_layers, n_kv_heads, head_dim = (
        model.get("n_layers"), model.get("n_kv_heads"), model.get("head_dim")
    )
    if all(isinstance(v, int) and v > 0 for v in (n_layers, n_kv_heads, head_dim)):
        kv = int(2 * int(n_layers) * int(n_kv_heads) * int(head_dim) * context_length * kv_bpe)
        return kv * slots, []

    params_b = float(model.get("parameter_billions") or model.get("params_b") or 7.0)
    fallback = int((params_b / 7.0) * (context_length / 4096) * 0.55 * GIB * (kv_bpe / 2.0) * slots)
    return fallback, ["Architecture KV-head metadata missing; using conservative KV-cache range."]


def _estimate_runtime_overhead(backend: str, weight_bytes: int) -> int:
    """Backend-specific compute graph, Metal/CUDA scratch, and runtime buffer overhead."""
    if backend == "unified_metal":
        return 384 * 1024 * 1024 + int(weight_bytes * 0.08)
    if backend == "discrete_gpu":
        return 384 * 1024 * 1024 + int(weight_bytes * 0.10)
    return 256 * 1024 * 1024 + int(weight_bytes * 0.06)


def _assess_single_model(
    *,
    model: dict[str, Any],
    budget: HardwareMemoryBudget,
    media_kind: str,
    context_length: int,
    profile: str,
    requested_kv: str | None,
    num_parallel: int,
) -> dict[str, Any]:
    weight_bytes, weight_notes, confidence = _estimate_weights(model)
    if weight_bytes is None:
        return {
            "value": {
                "fit_status": "Unknown", "weight_memory_estimate": None,
                "runtime_overhead_estimate": None, "kv_cache_estimate": None,
                "total_estimated_bytes": None, "available_budget": None,
                "context_length": context_length, "expected_backend": "unknown",
                "performance_estimate": "Not benchmarked yet", "reasons": weight_notes,
                "execution_plan": None, "gpu_budget_bytes": None, "cpu_spill_budget_bytes": None,
            },
            "unit": "bytes", "source": "estimated",
            "confidence": "unknown", "limitations": weight_notes,
        }

    overhead_bytes = _estimate_runtime_overhead(budget.backend, weight_bytes)
    f16_kv, kv_notes = _estimate_kv_cache(model, context_length, "f16", num_parallel)
    resolved_kv = resolve_kv_cache_type(
        profile, requested_kv, weight_bytes + f16_kv + overhead_bytes,
        budget.available_budget_bytes, context_length,
    )
    kv_bytes, _ = _estimate_kv_cache(model, context_length, resolved_kv, num_parallel)
    total_required = weight_bytes + kv_bytes + overhead_bytes
    limitations = weight_notes + kv_notes
    n_layers = int(model.get("n_layers") or 0)

    execution_plan = compute_execution_plan(
        profile=profile, kv_cache_type=resolved_kv, requested_ctx=context_length,
        weight_bytes=weight_bytes, kv_bytes=kv_bytes, overhead_bytes=overhead_bytes,
        n_layers=n_layers, budget=budget, media_kind=media_kind,
    )

    reasons: list[str] = []
    avail = budget.available_budget_bytes
    combined = budget.gpu_budget_bytes + budget.cpu_spill_budget_bytes
    hybrid_discrete = (
        budget.backend == "discrete_gpu"
        and n_layers > 0
        and 0 < execution_plan["num_gpu"] < n_layers
        and total_required <= combined
    )
    if total_required <= int(avail * 0.85):
        fit_status = "Recommended"
        reasons.append(
            f"Estimated runtime demand ({total_required / GIB:.1f} GiB) fits comfortably "
            f"within {avail / GIB:.1f} GiB safe budget."
        )
    elif total_required <= int(avail * 1.15):
        fit_status = "Borderline"
        reasons.append(
            f"Estimated demand ({total_required / GIB:.1f} GiB) is near your "
            f"{avail / GIB:.1f} GiB budget; reduce context or close background apps."
        )
    elif hybrid_discrete:
        fit_status = "Borderline"
        reasons.append(
            f"Hybrid GPU/RAM offload ({execution_plan['num_gpu']}/{n_layers} layers in VRAM) "
            f"fits combined {combined / GIB:.1f} GiB memory."
        )
    else:
        fit_status = "Not recommended"
        reasons.append(
            f"Estimated demand ({total_required / GIB:.1f} GiB) exceeds your "
            f"{avail / GIB:.1f} GiB safe budget."
        )

    if media_kind == "HDD":
        reasons.append("External HDD selected: model loads will be noticeably slower than SSD.")

    return {
        "value": {
            "fit_status": fit_status, "weight_memory_estimate": weight_bytes,
            "runtime_overhead_estimate": overhead_bytes, "kv_cache_estimate": kv_bytes,
            "total_estimated_bytes": total_required, "available_budget": avail,
            "context_length": context_length, "expected_backend": budget.backend,
            "performance_estimate": "Not benchmarked yet", "reasons": reasons,
            "execution_plan": execution_plan,
            "gpu_budget_bytes": budget.gpu_budget_bytes,
            "cpu_spill_budget_bytes": budget.cpu_spill_budget_bytes,
        },
        "unit": "bytes",
        "source": "calculated" if not limitations else "estimated",
        "confidence": confidence if not kv_notes else "medium",
        "limitations": limitations,
    }


def _normalize_hardware(params: dict[str, Any]) -> dict[str, Any]:
    hardware = dict(params.get("hardware") or {})
    if hardware:
        return hardware
    sys_prof = dict(params.get("system_profile") or {})
    if not sys_prof:
        return {}
    vram = sys_prof.get("gpu_vram_bytes")
    if vram is None and not sys_prof.get("is_unified_memory"):
        gpu_vrams = [
            int(g.get("vram_total_bytes") or g.get("vram_bytes") or 0)
            for g in (sys_prof.get("gpus") or []) if isinstance(g, dict)
        ]
        vram = max(gpu_vrams, default=0) or None
    return {
        "is_unified_memory": sys_prof.get("is_unified_memory", False),
        "ram_total_bytes": sys_prof.get("ram_total_bytes", 0),
        "ram_available_bytes": sys_prof.get("ram_available_bytes", 0),
        "ram_effective_avail_bytes": sys_prof.get("ram_effective_avail_bytes"),
        "metal_wired_limit_bytes": sys_prof.get("metal_wired_limit_bytes"),
        "gpu_vram_bytes": vram,
        "physical_cores": sys_prof.get("physical_cores"),
        "logical_cores": sys_prof.get("logical_cores"),
        "probe_psutil": sys_prof.get("probe_psutil", False),
    }


def assess_model_fit(params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
    """Assess single model compatibility against live hardware budget and storage media."""
    storage = params.get("storage") or {}
    media_kind = str(storage.get("media_kind") or params.get("media_kind") or "unknown").upper()
    context_length = max(512, int(params.get("context_length") or 4096))
    reserve_gib = float(params.get("safety_reserve_gib") or 2.0)
    budget = resolve_memory_budget(_normalize_hardware(params), reserve_gib)
    return _assess_single_model(
        model=params.get("model") or {}, budget=budget, media_kind=media_kind,
        context_length=context_length, profile=normalize_profile(params.get("execution_profile")),
        requested_kv=params.get("kv_cache_type"),
        num_parallel=max(1, int(params.get("num_parallel") or 1)),
    )


def assess_model_fit_batch(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    """Assess all curated catalog models in a single worker invocation."""
    models = params.get("models")
    if not isinstance(models, list):
        raise ValueError("models must be a list for estimate_fit_batch")
    storage = params.get("storage") or {}
    media_kind = str(storage.get("media_kind") or params.get("media_kind") or "unknown").upper()
    context_length = max(512, int(params.get("context_length") or 4096))
    reserve_gib = float(params.get("safety_reserve_gib") or 2.0)
    profile = normalize_profile(params.get("execution_profile"))
    requested_kv = params.get("kv_cache_type")
    num_parallel = max(1, int(params.get("num_parallel") or 1))
    budget = resolve_memory_budget(_normalize_hardware(params), reserve_gib)

    assessments: list[dict[str, Any]] = []
    for entry in models:
        if ctx.is_cancelled:
            break
        model = entry if isinstance(entry, dict) else {}
        res = _assess_single_model(
            model=model, budget=budget, media_kind=media_kind, context_length=context_length,
            profile=profile, requested_kv=requested_kv, num_parallel=num_parallel,
        )
        item = dict(res["value"])
        item["model_id"] = model.get("ollama_name") or model.get("model_id") or model.get("name")
        item["source"] = res["source"]
        item["confidence"] = res["confidence"]
        item["limitations"] = res["limitations"]
        assessments.append(item)

    return {
        "value": {"assessments": assessments, "cancelled": ctx.is_cancelled},
        "unit": "bytes", "source": "calculated", "confidence": "high", "limitations": [],
    }
