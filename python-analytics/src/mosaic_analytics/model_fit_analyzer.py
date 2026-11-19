"""Hardware-aware model-fit, KV-cache quantization, and batch assessment engine."""

from __future__ import annotations

from typing import Any

from mosaic_analytics.execution_planner import (
    GIB,
    HardwareMemoryBudget,
    compute_execution_plan,
    resolve_kv_cache_type,
)
from mosaic_analytics.fit_inputs import is_pos_num, parse_fit_params
from mosaic_analytics.numeric import MAX_SAFE_BYTES, MAX_SAFE_COUNT, safe_int, safe_scaled_int
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
    raw_size = model.get("download_size_bytes")
    size_bytes = raw_size if is_pos_num(raw_size) else model.get("estimated_bytes")
    if is_pos_num(size_bytes):
        return safe_scaled_int(size_bytes, 1.03, min_value=1), [], "high"

    raw_params = model.get("parameter_billions")
    params_b = raw_params if is_pos_num(raw_params) else model.get("params_b")
    quant = str(model.get("quantization") or "Q4_K_M").upper()
    if is_pos_num(params_b):
        bpw = QUANT_BPW.get(quant, 4.85)
        estimated = safe_scaled_int(params_b, 1e9 * (bpw / 8.0) * 1.05, min_value=1)
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
    ctx_len = max(1, safe_int(context_length, 4096, max_value=MAX_SAFE_COUNT))
    slots = max(1, safe_int(num_parallel, 1, max_value=MAX_SAFE_COUNT))
    n_layers = safe_int(model.get("n_layers"), 0, max_value=1_000_000)
    n_kv_heads = safe_int(model.get("n_kv_heads"), 0, max_value=1_000_000)
    head_dim = safe_int(model.get("head_dim"), 0, max_value=1_000_000)
    if n_layers > 0 and n_kv_heads > 0 and head_dim > 0:
        kv_base = 2 * n_layers * n_kv_heads * head_dim * ctx_len
        return safe_scaled_int(kv_base, kv_bpe * slots, min_value=0), []

    raw_p = model.get("parameter_billions")
    p_cand = raw_p if is_pos_num(raw_p) else model.get("params_b")
    params_b = float(p_cand) if is_pos_num(p_cand) else 7.0
    fallback = safe_scaled_int(
        params_b / 7.0, (ctx_len / 4096) * 0.55 * GIB * (kv_bpe / 2.0) * slots, min_value=0
    )
    return fallback, ["Architecture KV-head metadata missing; using conservative KV-cache range."]


def _estimate_runtime_overhead(backend: str, weight_bytes: int) -> int:
    """Backend-specific compute graph, Metal/CUDA scratch, and runtime buffer overhead."""
    if backend == "unified_metal":
        return min(MAX_SAFE_BYTES, 384 * 1024 * 1024 + safe_scaled_int(weight_bytes, 0.08))
    if backend == "discrete_gpu":
        return min(MAX_SAFE_BYTES, 384 * 1024 * 1024 + safe_scaled_int(weight_bytes, 0.10))
    return min(MAX_SAFE_BYTES, 256 * 1024 * 1024 + safe_scaled_int(weight_bytes, 0.06))


def _unknown_assessment(context_length: int, reasons: list[str]) -> dict[str, Any]:
    return {
        "value": {
            "fit_status": "Unknown", "weight_memory_estimate": None,
            "runtime_overhead_estimate": None, "kv_cache_estimate": None,
            "total_estimated_bytes": None, "available_budget": None,
            "context_length": context_length, "requested_context_length": context_length,
            "expected_backend": "unknown", "performance_estimate": "Not benchmarked yet",
            "reasons": reasons, "execution_plan": None,
            "gpu_budget_bytes": None, "cpu_spill_budget_bytes": None,
        },
        "unit": "bytes", "source": "estimated", "confidence": "unknown", "limitations": reasons,
    }


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
        return _unknown_assessment(context_length, weight_notes)

    overhead_bytes = _estimate_runtime_overhead(budget.backend, weight_bytes)
    f16_kv, kv_notes = _estimate_kv_cache(model, context_length, "f16", num_parallel)
    resolved_kv = resolve_kv_cache_type(
        profile, requested_kv, weight_bytes + f16_kv + overhead_bytes,
        budget.available_budget_bytes, context_length,
    )
    kv_bytes, _ = _estimate_kv_cache(model, context_length, resolved_kv, num_parallel)
    limitations = weight_notes + kv_notes
    n_layers = max(0, safe_int(model.get("n_layers"), 0, max_value=1_000_000))

    execution_plan = compute_execution_plan(
        profile=profile, kv_cache_type=resolved_kv, requested_ctx=context_length,
        weight_bytes=weight_bytes, kv_bytes=kv_bytes, overhead_bytes=overhead_bytes,
        n_layers=n_layers, budget=budget, media_kind=media_kind, num_parallel=num_parallel,
    )
    plan_ctx = int(execution_plan["num_ctx"])
    if plan_ctx < context_length:
        kv_bytes, _ = _estimate_kv_cache(model, plan_ctx, resolved_kv, num_parallel)
    total_required = weight_bytes + kv_bytes + overhead_bytes

    reasons: list[str] = []
    avail = budget.available_budget_bytes
    combined = budget.gpu_budget_bytes + budget.cpu_spill_budget_bytes
    hybrid_offload = (
        budget.backend in {"discrete_gpu", "unified_metal"}
        and n_layers > 0
        and 0 < execution_plan["num_gpu"] < n_layers
        and total_required <= combined
    )
    if total_required <= safe_scaled_int(avail, 0.85):
        fit_status = "Recommended"
        reasons.append(
            f"Estimated runtime demand ({total_required / GIB:.1f} GiB) fits comfortably "
            f"within {avail / GIB:.1f} GiB safe budget."
        )
    elif total_required <= safe_scaled_int(avail, 1.15):
        fit_status = "Borderline"
        reasons.append(
            f"Estimated demand ({total_required / GIB:.1f} GiB) is near your "
            f"{avail / GIB:.1f} GiB budget; reduce context or close background apps."
        )
    elif hybrid_offload:
        fit_status = "Borderline"
        if budget.backend == "unified_metal":
            reasons.append(
                f"Hybrid Metal/unified RAM spill ({execution_plan['num_gpu']}/{n_layers} layers "
                f"within Metal wired cap) fits combined {combined / GIB:.1f} GiB unified memory."
            )
        else:
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

    if plan_ctx < context_length:
        reasons.append(
            f"Context auto-adjusted from {context_length} to {plan_ctx} to fit memory budget."
        )
    if media_kind == "HDD":
        reasons.append("External HDD selected: model loads will be noticeably slower than SSD.")

    return {
        "value": {
            "fit_status": fit_status, "weight_memory_estimate": weight_bytes,
            "runtime_overhead_estimate": overhead_bytes, "kv_cache_estimate": kv_bytes,
            "total_estimated_bytes": total_required, "available_budget": avail,
            "context_length": plan_ctx, "requested_context_length": context_length,
            "expected_backend": budget.backend,
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


def assess_model_fit(params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
    """Assess single model compatibility against live hardware budget and storage media."""
    media_kind, ctx_len, profile, req_kv, num_parallel, budget = parse_fit_params(params)
    raw_model = params.get("model")
    return _assess_single_model(
        model=raw_model if isinstance(raw_model, dict) else {},
        budget=budget, media_kind=media_kind, context_length=ctx_len,
        profile=profile, requested_kv=req_kv, num_parallel=num_parallel,
    )


def assess_model_fit_batch(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    """Assess all curated catalog models in a single worker invocation."""
    models = params.get("models")
    if not isinstance(models, list):
        raise ValueError("models must be a list for estimate_fit_batch")
    media_kind, ctx_len, profile, req_kv, num_parallel, budget = parse_fit_params(params)

    assessments: list[dict[str, Any]] = []
    for entry in models:
        if ctx.is_cancelled:
            break
        model = entry if isinstance(entry, dict) else {}
        model_id = model.get("ollama_name") or model.get("model_id") or model.get("name")
        try:
            res = _assess_single_model(
                model=model, budget=budget, media_kind=media_kind, context_length=ctx_len,
                profile=profile, requested_kv=req_kv, num_parallel=num_parallel,
            )
        except (ValueError, TypeError, OverflowError) as exc:
            res = _unknown_assessment(ctx_len, [f"Malformed model entry: {exc}"])
        item = dict(res["value"])
        item["model_id"] = model_id
        item["source"] = res["source"]
        item["confidence"] = res["confidence"]
        item["limitations"] = res["limitations"]
        assessments.append(item)

    return {
        "value": {"assessments": assessments, "cancelled": ctx.is_cancelled},
        "unit": "bytes", "source": "calculated", "confidence": "high", "limitations": [],
    }
