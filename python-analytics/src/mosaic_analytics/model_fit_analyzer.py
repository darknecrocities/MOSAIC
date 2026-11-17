"""Hardware-aware model-fit and KV-cache memory estimator."""

from __future__ import annotations

from typing import Any

from mosaic_analytics.protocol import JobContext

QUANT_BPW: dict[str, float] = {
    "Q2_K": 3.1,
    "Q3_K_M": 3.9,
    "Q4_0": 4.5,
    "Q4_K_M": 4.85,
    "Q5_K_M": 5.7,
    "Q6_K": 6.6,
    "Q8_0": 8.5,
    "FP16": 16.0,
}

GIB = 1024**3


def _estimate_weights(model: dict[str, Any]) -> tuple[int | None, list[str], str]:
    """Estimate runtime weight memory in bytes from exact size or parameter count."""
    size_bytes = model.get("download_size_bytes")
    if isinstance(size_bytes, int | float) and size_bytes > 0:
        # GGUF file size closely tracks quantized weight footprint plus small tensor headers.
        return int(size_bytes * 1.03), [], "high"

    params_b = model.get("parameter_billions")
    quant = str(model.get("quantization") or "Q4_K_M").upper()
    if isinstance(params_b, int | float) and params_b > 0:
        bpw = QUANT_BPW.get(quant, 4.85)
        estimated = int(params_b * 1e9 * (bpw / 8.0) * 1.05)
        notes = [f"Weight memory estimated from {params_b}B params at {quant} ({bpw} bpw)."]
        return estimated, notes, "medium"

    return None, ["Insufficient model weight or parameter metadata."], "unknown"


def _estimate_kv_cache(model: dict[str, Any], context_length: int) -> tuple[int, list[str]]:
    """Compute KV cache bytes using GQA head dimensions when known."""
    n_layers = model.get("n_layers")
    n_kv_heads = model.get("n_kv_heads")
    head_dim = model.get("head_dim")
    if all(isinstance(v, int) and v > 0 for v in (n_layers, n_kv_heads, head_dim)):
        # 2 tensors (K and V) * fp16 (2 bytes)
        kv_bytes = 2 * int(n_layers) * int(n_kv_heads) * int(head_dim) * context_length * 2
        return kv_bytes, []

    params_b = float(model.get("parameter_billions") or 7.0)
    fallback = int((params_b / 7.0) * (context_length / 4096) * 0.55 * GIB)
    return fallback, ["Architecture KV-head metadata missing; using conservative KV-cache range."]


def _estimate_runtime_overhead(backend: str, weight_bytes: int) -> int:
    """Backend-specific compute graph, Metal/CUDA scratch, and runtime buffer overhead."""
    base = 384 * 1024 * 1024
    if backend == "unified_metal":
        return base + int(weight_bytes * 0.08)
    if backend == "discrete_gpu":
        return base + int(weight_bytes * 0.10)
    return 256 * 1024 * 1024 + int(weight_bytes * 0.06)


def assess_model_fit(params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
    """Assess model compatibility against live hardware budget and storage media."""
    model = params.get("model") or {}
    hardware = params.get("hardware") or {}
    storage = params.get("storage") or {}
    context_length = max(512, int(params.get("context_length") or 4096))
    reserve_gib = float(params.get("safety_reserve_gib") or 2.0)

    weight_bytes, weight_notes, confidence = _estimate_weights(model)
    if weight_bytes is None:
        return {
            "value": {
                "fit_status": "Unknown",
                "weight_memory_estimate": None,
                "runtime_overhead_estimate": None,
                "kv_cache_estimate": None,
                "available_budget": None,
                "expected_backend": "unknown",
                "performance_estimate": "Not benchmarked yet",
                "reasons": weight_notes,
            },
            "unit": "bytes",
            "source": "estimated",
            "confidence": "unknown",
            "limitations": weight_notes,
        }

    is_unified = bool(hardware.get("is_unified_memory"))
    vram_bytes = hardware.get("gpu_vram_bytes")
    ram_avail = int(hardware.get("ram_available_bytes") or 0)
    ram_total = int(hardware.get("ram_total_bytes") or 0)

    if is_unified:
        backend = "unified_metal"
        # Use measured available unified RAM, reserving OS headroom.
        raw_budget = ram_avail if ram_avail > 0 else int(ram_total * 0.65)
        available_budget = max(0, raw_budget - int(reserve_gib * GIB))
    elif isinstance(vram_bytes, int) and vram_bytes > 0:
        backend = "discrete_gpu"
        available_budget = max(0, vram_bytes - int(0.5 * GIB))
    else:
        backend = "cpu_ram"
        raw_budget = ram_avail if ram_avail > 0 else int(ram_total * 0.6)
        available_budget = max(0, raw_budget - int(reserve_gib * GIB))

    kv_bytes, kv_notes = _estimate_kv_cache(model, context_length)
    overhead_bytes = _estimate_runtime_overhead(backend, weight_bytes)
    total_required = weight_bytes + kv_bytes + overhead_bytes
    limitations = weight_notes + kv_notes

    reasons: list[str] = []
    if total_required <= int(available_budget * 0.85):
        fit_status = "Recommended"
        reasons.append(
            f"Estimated runtime demand ({total_required / GIB:.1f} GiB) fits comfortably "
            f"within {available_budget / GIB:.1f} GiB safe budget."
        )
    elif total_required <= int(available_budget * 1.15):
        fit_status = "Borderline"
        reasons.append(
            f"Estimated demand ({total_required / GIB:.1f} GiB) is near your "
            f"{available_budget / GIB:.1f} GiB budget; reduce context or close background apps."
        )
    else:
        fit_status = "Not recommended"
        reasons.append(
            f"Estimated demand ({total_required / GIB:.1f} GiB) exceeds your "
            f"{available_budget / GIB:.1f} GiB safe budget."
        )

    if str(storage.get("media_kind") or "").upper() == "HDD":
        reasons.append("External HDD selected: model loads will be noticeably slower than SSD.")

    return {
        "value": {
            "fit_status": fit_status,
            "weight_memory_estimate": weight_bytes,
            "runtime_overhead_estimate": overhead_bytes,
            "kv_cache_estimate": kv_bytes,
            "total_estimated_bytes": total_required,
            "available_budget": available_budget,
            "context_length": context_length,
            "expected_backend": backend,
            "performance_estimate": "Not benchmarked yet",
            "reasons": reasons,
        },
        "unit": "bytes",
        "source": "calculated" if not limitations else "estimated",
        "confidence": confidence if not kv_notes else "medium",
        "limitations": limitations,
    }
