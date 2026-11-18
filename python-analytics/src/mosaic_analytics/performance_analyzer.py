"""Bottleneck explanation, efficiency ratios, and comparative run analysis."""

from __future__ import annotations

from typing import Any

from mosaic_analytics.numeric import safe_float, safe_int, safe_optional_float
from mosaic_analytics.protocol import JobContext


def _metric_median(metric: Any) -> float | None:
    if isinstance(metric, dict):
        return safe_optional_float(metric.get("median"))
    return safe_optional_float(metric)


def analyze_performance(params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
    """Identify memory, offload, KV-cache, prompt-eval, and storage bottlenecks."""
    fit = params.get("fit") if isinstance(params.get("fit"), dict) else {}
    storage = params.get("storage") if isinstance(params.get("storage"), dict) else {}
    report = params.get("report")
    raw_hw = params.get("system_profile") or params.get("hardware")
    hardware = raw_hw if isinstance(raw_hw, dict) else {}
    raw_plan = params.get("execution_plan") or fit.get("execution_plan")
    execution_plan = raw_plan if isinstance(raw_plan, dict) else {}

    bottlenecks: list[dict[str, str]] = []
    recommendations: list[str] = []

    backend = str(fit.get("expected_backend") or "unknown")
    fit_status = str(fit.get("fit_status") or "Unknown")
    media_kind = str(
        storage.get("media_kind") or params.get("media_kind") or "unknown"
    ).upper()

    if fit_status in {"Borderline", "Not recommended"}:
        bottlenecks.append(
            {
                "category": "memory_pressure",
                "severity": "high" if fit_status == "Not recommended" else "medium",
                "explanation": "Model + KV cache approaches or exceeds safe RAM/VRAM headroom.",
            }
        )
    if backend == "cpu_ram":
        bottlenecks.append(
            {
                "category": "compute_backend",
                "severity": "medium",
                "explanation": (
                    "CPU-only execution path has lower generation throughput than GPU/Metal."
                ),
            }
        )
    if media_kind == "HDD":
        bottlenecks.append(
            {
                "category": "storage_throughput",
                "severity": "medium",
                "explanation": "External HDD sequential reads slow initial model loading.",
            }
        )

    efficiency_ratios: dict[str, float | None] = {}
    if isinstance(report, dict) and report:
        cold_ms = safe_float(report.get("cold_load_ms"), 0.0)
        warm_median = _metric_median(report.get("warm_load_ms"))
        ttft_median = _metric_median(report.get("ttft_ms"))
        tps_median = _metric_median(report.get("generation_tok_per_sec"))
        peak_ram = safe_float(report.get("peak_ram_used_bytes"), 0.0)
        raw_ram_total = hardware.get("ram_total_bytes")
        if raw_ram_total is None:
            raw_ram_total = hardware.get("total_bytes")
        ram_total = safe_float(raw_ram_total, 0.0)

        cold_warm_ratio = (
            round(cold_ms / warm_median, 2) if warm_median and warm_median > 0 else None
        )
        mem_util = round(peak_ram / ram_total, 3) if ram_total > 0 and peak_ram > 0 else None
        offload_ratio = safe_optional_float(execution_plan.get("offload_ratio"))

        efficiency_ratios = {
            "cold_to_warm_load_ratio": cold_warm_ratio,
            "memory_utilization_ratio": mem_util,
            "offload_ratio": offload_ratio,
        }

        if media_kind != "HDD" and (
            cold_ms > 15_000.0 or (cold_warm_ratio is not None and cold_warm_ratio > 10.0)
        ):
            bottlenecks.append(
                {
                    "category": "storage_throughput",
                    "severity": "high" if cold_ms > 30_000.0 else "medium",
                    "explanation": (
                        f"Cold model load ({cold_ms / 1000.0:.1f}s) indicates slow external "
                        "storage I/O or mmap paging."
                    ),
                }
            )
            recommendations.append("Use an NVMe SSD or keep warm keep_alive for frequent runs.")

        if (offload_ratio is not None and offload_ratio < 1.0) or (
            tps_median is not None and 0.0 < tps_median < 5.0
        ):
            sev = "high" if (tps_median is not None and tps_median < 2.5) else "medium"
            bottlenecks.append(
                {
                    "category": "partial_offload",
                    "severity": sev,
                    "explanation": (
                        "Partial GPU/Metal layer offload or CPU fallback lowers token throughput."
                    ),
                }
            )
            recommendations.append(
                "Switch to IQ2_XS/IQ3_XXS quantization or a sparse MoE model to fit GPU/Metal."
            )

        if ttft_median is not None and ttft_median > 3000.0:
            bottlenecks.append(
                {
                    "category": "prompt_eval_latency",
                    "severity": "medium",
                    "explanation": (
                        f"Time-to-first-token ({ttft_median:.0f} ms) shows heavy prompt prefill."
                    ),
                }
            )
            recommendations.append("Lower num_ctx or tune num_batch/num_ubatch for faster prefill.")

        kv_type = str(
            execution_plan.get("kv_cache_type") or params.get("kv_cache_type") or "f16"
        ).lower()
        raw_ctx = report.get("context_length")
        if raw_ctx is None:
            raw_ctx = execution_plan.get("num_ctx")
        ctx_len = safe_int(raw_ctx, 4096)
        if kv_type == "f16" and ((mem_util is not None and mem_util > 0.70) or ctx_len >= 8192):
            bottlenecks.append(
                {
                    "category": "kv_cache_pressure",
                    "severity": "medium",
                    "explanation": "FP16 KV cache consumes excess memory at high context or load.",
                }
            )
            recommendations.append(
                "Enable q8_0/q4_0 KV quantization with OLLAMA_FLASH_ATTENTION=1 and num_parallel=1."
            )

    return {
        "value": {
            "bottlenecks": bottlenecks,
            "efficiency_ratios": efficiency_ratios,
            "recommendations": recommendations,
            "summary": (
                "No major hardware bottlenecks detected."
                if not bottlenecks
                else f"Identified {len(bottlenecks)} potential constraint(s)."
            ),
        },
        "unit": None,
        "source": "calculated",
        "confidence": "high" if isinstance(report, dict) and report else "medium",
        "limitations": (
            []
            if isinstance(report, dict) and report
            else ["Exact tokens/sec requires running a local device benchmark."]
        ),
    }
