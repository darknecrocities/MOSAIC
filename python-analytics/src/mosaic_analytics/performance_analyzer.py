"""Bottleneck explanation and comparative run analysis."""

from __future__ import annotations

from typing import Any

from mosaic_analytics.protocol import JobContext


def analyze_performance(params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
    """Identify likely memory, offload, or external-storage bottlenecks."""
    fit = params.get("fit") or {}
    storage = params.get("storage") or {}
    bottlenecks: list[dict[str, str]] = []

    backend = str(fit.get("expected_backend") or "unknown")
    fit_status = str(fit.get("fit_status") or "Unknown")
    media_kind = str(storage.get("media_kind") or "unknown").upper()

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

    return {
        "value": {
            "bottlenecks": bottlenecks,
            "summary": (
                "No major hardware bottlenecks detected."
                if not bottlenecks
                else f"Identified {len(bottlenecks)} potential constraint(s)."
            ),
        },
        "unit": None,
        "source": "calculated",
        "confidence": "medium",
        "limitations": ["Exact tokens/sec requires running a local device benchmark."],
    }
