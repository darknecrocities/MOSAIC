"""Controlled, reproducible Ollama benchmark runner with adaptive runtime options."""

from __future__ import annotations

import json
import statistics
import urllib.parse
import urllib.request
from typing import Any

import psutil

from mosaic_analytics.numeric import safe_float, safe_int, safe_optional_float
from mosaic_analytics.protocol import JobContext

FIXED_PROMPT = "Explain in two concise sentences why local model memory depends on quantization."
ALLOWED_OPTION_KEYS = (
    "num_gpu",
    "num_batch",
    "num_ubatch",
    "num_thread",
    "use_mmap",
    "use_mlock",
    "num_ctx",
    "temperature",
    "num_predict",
)


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


def _resolve_cold_timeout_s(params: dict[str, Any]) -> float:
    explicit = safe_optional_float(params.get("cold_load_timeout_s"))
    if explicit is not None and explicit > 0:
        return max(30.0, explicit)

    size_bytes = safe_float(params.get("model_size_bytes"), 0.0)
    if size_bytes <= 0:
        return 180.0
    media_kind = str(params.get("media_kind") or "unknown").upper()
    rate_bps = 250 * 1024 * 1024 if media_kind in {"SSD", "NVME"} else 60 * 1024 * 1024
    estimated = (size_bytes / rate_bps) * 1.5 + 60.0
    return max(180.0, min(900.0, round(estimated, 1)))


def _build_options(params: dict[str, Any], context_length: int) -> dict[str, Any]:
    options: dict[str, Any] = {
        "num_ctx": context_length,
        "temperature": 0.0,
        "num_predict": 64,
    }
    raw_opts = params.get("options") or params.get("execution_plan") or {}
    if isinstance(raw_opts, dict):
        for key in ALLOWED_OPTION_KEYS:
            val = raw_opts.get(key)
            if val is not None:
                options[key] = val
    return options


def _resolve_applied_metadata(params: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
    applied = dict(options)
    raw_opts = params.get("options") or params.get("execution_plan") or {}
    if not isinstance(raw_opts, dict):
        raw_opts = {}

    profile = (
        params.get("execution_profile")
        or raw_opts.get("execution_profile")
        or raw_opts.get("profile")
    )
    if isinstance(profile, str) and profile.strip():
        applied["execution_profile"] = profile.strip().lower()

    kv_raw = params.get("kv_cache_type") or raw_opts.get("kv_cache_type")
    if isinstance(kv_raw, str) and kv_raw.strip():
        kv_norm = kv_raw.strip().lower()
        if kv_norm == "auto":
            prof = applied.get("execution_profile")
            if prof == "constrained_memory":
                kv_norm = "q4_0"
            elif prof == "balanced":
                kv_norm = "q8_0"
            elif prof == "max_quality":
                kv_norm = "f16"
        applied["kv_cache_type"] = kv_norm

    offload = safe_optional_float(params.get("offload_ratio"))
    if offload is None:
        offload = safe_optional_float(raw_opts.get("offload_ratio"))
    if offload is None:
        ngl = options.get("num_gpu")
        n_layers = safe_int(params.get("n_layers") or raw_opts.get("n_layers"), 0)
        if isinstance(ngl, int) and not isinstance(ngl, bool):
            if ngl == 0:
                offload = 0.0
            elif ngl >= 999:
                offload = 1.0
            elif n_layers > 0 and ngl > 0:
                offload = min(1.0, ngl / n_layers)
    if offload is not None and 0.0 <= offload <= 1.0:
        applied["offload_ratio"] = round(offload, 3)

    return applied


def run_benchmark(params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
    """Execute cold-load and repeated warm-load trials against Ollama."""
    endpoint = _validate_loopback(str(params.get("endpoint") or "http://127.0.0.1:11434"))
    model = str(params.get("model") or "")
    if not model:
        raise ValueError("model is required for benchmarking")

    repetitions = max(2, min(10, safe_int(params.get("repetitions"), 3)))
    context_length = max(512, safe_int(params.get("context_length"), 4096))
    prompt = str(params.get("prompt") or FIXED_PROMPT)
    cold_timeout_s = _resolve_cold_timeout_s(params)
    warm_raw = safe_optional_float(params.get("warm_load_timeout_s"))
    warm_timeout_s = max(30.0, warm_raw if (warm_raw is not None and warm_raw > 0) else 120.0)
    options = _build_options(params, context_length)
    applied_options = _resolve_applied_metadata(params, options)
    keep_alive = params.get("keep_alive")

    idle_vm = psutil.virtual_memory()
    idle_available = int(idle_vm.available)
    peak_used = int(idle_vm.used)

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

        body: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "options": options,
        }
        if keep_alive is not None:
            body["keep_alive"] = keep_alive

        res = _post_json(
            f"{endpoint}/api/generate",
            body,
            timeout_s=cold_timeout_s if idx == 0 else warm_timeout_s,
        )
        load_ms = safe_float(res.get("load_duration"), 0.0) / 1e6
        prompt_eval_ms = safe_float(res.get("prompt_eval_duration"), 0.0) / 1e6
        eval_ns = safe_float(res.get("eval_duration"), 0.0)
        eval_count = safe_int(res.get("eval_count"), 0)
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
            "context_length": safe_int(options.get("num_ctx"), context_length),
            "repetitions": repetitions,
            "idle_available_bytes": idle_available,
            "peak_ram_used_bytes": peak_used,
            "cold_load_ms": cold_load_ms,
            "warm_load_ms": _summarize(warm_loads) if warm_loads else None,
            "ttft_ms": _summarize(ttft_samples),
            "generation_tok_per_sec": _summarize(tps_samples),
            "applied_options": applied_options,
            "cold_load_timeout_s": cold_timeout_s,
        },
        "unit": "mixed",
        "source": "measured",
        "confidence": "high",
        "limitations": [],
    }
