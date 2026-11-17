"""Controlled, reproducible Ollama benchmark runner."""

from __future__ import annotations

import json
import statistics
import urllib.parse
import urllib.request
from typing import Any

import psutil

from mosaic_analytics.protocol import JobContext

FIXED_PROMPT = "Explain in two concise sentences why local model memory depends on quantization."


def _validate_loopback(endpoint: str) -> str:
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError(f"Benchmark endpoint must be loopback: {endpoint!r}")
    return endpoint.rstrip("/")


def _post_json(url: str, payload: dict[str, Any], timeout_s: float = 60.0) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310
        return json.loads(resp.read().decode("utf-8"))


def _summarize(values: list[float]) -> dict[str, float]:
    return {
        "median": round(statistics.median(values), 2),
        "min": round(min(values), 2),
        "max": round(max(values), 2),
    }


def run_benchmark(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    """Execute cold-load and repeated warm-load trials against Ollama."""
    endpoint = _validate_loopback(str(params.get("endpoint") or "http://127.0.0.1:11434"))
    model = str(params.get("model") or "")
    if not model:
        raise ValueError("model is required for benchmarking")

    repetitions = max(2, min(10, int(params.get("repetitions") or 3)))
    context_length = max(512, int(params.get("context_length") or 4096))
    prompt = str(params.get("prompt") or FIXED_PROMPT)
    cold_timeout_s = float(params.get("cold_load_timeout_s") or 180.0)
    warm_timeout_s = float(params.get("warm_load_timeout_s") or 120.0)

    idle_vm = psutil.virtual_memory()
    idle_available = int(idle_vm.available)
    peak_used = int(idle_vm.used)

    # Unload before cold-load measurement
    try:
        _post_json(f"{endpoint}/api/generate", {"model": model, "keep_alive": 0}, timeout_s=10.0)
    except Exception:  # noqa: BLE001
        pass

    ttft_samples: list[float] = []
    tps_samples: list[float] = []
    cold_load_ms = 0.0
    warm_loads: list[float] = []

    for idx in range(repetitions):
        if ctx.is_cancelled:
            return {
                "value": {"cancelled": True, "completed_trials": idx},
                "unit": None,
                "source": "measured",
                "confidence": "unknown",
                "limitations": ["Benchmark cancelled before completion."],
            }

        res = _post_json(
            f"{endpoint}/api/generate",
            {
                "model": model,
                "prompt": prompt,
                "stream": False,
                "options": {"num_ctx": context_length, "temperature": 0.0, "num_predict": 64},
            },
            timeout_s=cold_timeout_s if idx == 0 else warm_timeout_s,
        )
        load_ms = float(res.get("load_duration", 0)) / 1e6
        prompt_eval_ms = float(res.get("prompt_eval_duration", 0)) / 1e6
        eval_ns = float(res.get("eval_duration", 0))
        eval_count = int(res.get("eval_count", 0))
        tps = (eval_count / (eval_ns / 1e9)) if eval_ns > 0 and eval_count > 0 else 0.0

        if idx == 0:
            cold_load_ms = round(load_ms, 2)
        else:
            warm_loads.append(load_ms)

        ttft_samples.append(prompt_eval_ms)
        tps_samples.append(tps)
        peak_used = max(peak_used, int(psutil.virtual_memory().used))

    return {
        "value": {
            "model": model,
            "context_length": context_length,
            "repetitions": repetitions,
            "idle_available_bytes": idle_available,
            "peak_ram_used_bytes": peak_used,
            "cold_load_ms": cold_load_ms,
            "warm_load_ms": _summarize(warm_loads) if warm_loads else None,
            "ttft_ms": _summarize(ttft_samples),
            "generation_tok_per_sec": _summarize(tps_samples),
        },
        "unit": "mixed",
        "source": "measured",
        "confidence": "high",
        "limitations": [],
    }
