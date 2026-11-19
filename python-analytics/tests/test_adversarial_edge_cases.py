"""Adversarial edge-case tests for report export, benchmark, planner, cluster RPC, and hardware."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

from mosaic_analytics import (
    benchmark_runner,
    cluster_planner,
    execution_planner,
    hardware_analyzer,
    model_fit_analyzer,
    performance_analyzer,
    report_exporter,
)
from mosaic_analytics.model_fit_analyzer import GIB, QUANT_BPW
from mosaic_analytics.protocol import JobContext


def _ctx() -> JobContext:
    return JobContext(job_id="adv-py", cancel_event=threading.Event())


def test_report_exporter_neutralizes_csv_formulas_and_handles_nondict_and_nan() -> None:
    csv_res = report_exporter.export_report(
        {
            "format": "csv",
            "report": {
                "=key": "=CMD('calc')",
                "plus": "+1+1",
                "minus": "-2+3",
                "at": "@SUM(A1)",
                "tab": "\t=1",
                "cr": "\r=2",
            },
        },
        _ctx(),
    )
    content = csv_res["value"]["content"]
    assert "'=key,'=CMD('calc')" in content
    assert "plus,'+1+1" in content
    assert "minus,'-2+3" in content
    assert "at,'@SUM(A1)" in content
    assert "'\t=1" in content
    assert "'\r=2" in content

    for bad_report in (["a", "b"], "oops", 123):
        with pytest.raises(ValueError, match="dictionary"):
            report_exporter.export_report({"format": "csv", "report": bad_report}, _ctx())

    json_res = report_exporter.export_report(
        {
            "format": "json",
            "report": {"tok_s": float("nan"), "nested": [float("inf"), 12.5]},
        },
        _ctx(),
    )

    def _reject_nan(token: str) -> Any:
        raise ValueError(f"Invalid JSON constant: {token}")

    parsed = json.loads(json_res["value"]["content"], parse_constant=_reject_nan)
    assert parsed["tok_s"] is None
    assert parsed["nested"] == [None, 12.5]


def test_benchmark_runner_resolves_auto_adaptive_kv_rejects_bad_loopback_and_clamps_options(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_payloads: list[dict[str, Any]] = []

    def fake_post(_url: str, payload: dict[str, Any], timeout_s: float = 60.0) -> dict[str, Any]:
        if payload.get("keep_alive") == 0:
            return {"done": True}
        captured_payloads.append(payload)
        return {
            "done": True,
            "load_duration": 100_000_000,
            "prompt_eval_duration": 50_000_000,
            "eval_duration": 500_000_000,
            "eval_count": 20,
        }

    monkeypatch.setattr(benchmark_runner, "_post_json", fake_post)
    res = benchmark_runner.run_benchmark(
        {
            "endpoint": "http://127.0.0.1:11434",
            "model": "qwen3:30b-a3b",
            "repetitions": 2,
            "context_length": 8192,
            "execution_profile": "auto_adaptive",
            "kv_cache_type": "auto",
            "system_profile": {"ram_total_bytes": 64 * GIB, "ram_available_bytes": 48 * GIB},
            "options": {"num_gpu": -99, "temperature": 999},
        },
        _ctx(),
    )
    applied = res["value"]["applied_options"]
    assert applied["kv_cache_type"] == "f16"
    assert captured_payloads[0]["options"]["num_gpu"] == 0
    assert captured_payloads[0]["options"]["temperature"] == 2.0
    assert captured_payloads[0]["options"]["num_ctx"] == 8192

    perf = performance_analyzer.analyze_performance(
        {
            "report": res["value"],
            "system_profile": {"ram_total_bytes": 64 * GIB},
            "storage": {"media_kind": "SSD"},
        },
        _ctx(),
    )
    cats = [b["category"] for b in perf["value"]["bottlenecks"]]
    assert "kv_cache_pressure" in cats

    for bad_ep in (
        "http://evil:pw@127.0.0.1:11434/extra?a=1#frag",
        "http://127.0.0.1:11434/proxy",
        "http://127.0.0.1:11434/?x=1",
        "http://127.0.0.1:11434/#frag",
    ):
        with pytest.raises(ValueError, match="loopback"):
            benchmark_runner.run_benchmark({"endpoint": bad_ep, "model": "llama3.2:1b"}, _ctx())

    with pytest.raises(ValueError, match="model is required"):
        benchmark_runner.run_benchmark(
            {"endpoint": "http://127.0.0.1:11434", "model": "   "}, _ctx()
        )

    captured_payloads.clear()
    clamped = benchmark_runner.run_benchmark(
        {
            "endpoint": "http://127.0.0.1:11434",
            "model": "llama3.2:1b",
            "repetitions": 2,
            "context_length": 4096,
            "options": {"num_ctx": "bad_str", "num_gpu": "bad", "temperature": "nope"},
        },
        _ctx(),
    )
    assert clamped["value"]["context_length"] == 4096
    assert captured_payloads[0]["options"]["num_ctx"] == 4096
    assert "num_gpu" not in captured_payloads[0]["options"]
    assert captured_payloads[0]["options"]["temperature"] == 0.0


def test_benchmark_runner_blocks_http_redirects() -> None:
    class _RedirectHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/latest")
            self.end_headers()

        def log_message(self, _fmt: str, *_args: object) -> None:
            return

    server = HTTPServer(("127.0.0.1", 0), _RedirectHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with pytest.raises(Exception, match="redirects"):
            benchmark_runner._post_json(f"http://127.0.0.1:{port}/api/generate", {"model": "m"})
    finally:
        server.shutdown()


def test_execution_planner_preserves_zero_avail_ram_and_uses_combined_budget_for_ctx(
    qwen3_30b_iq2: dict[str, Any],
) -> None:
    assert (
        execution_planner.resolve_effective_ram_avail(
            {"is_unified_memory": False, "ram_total_bytes": 4 * GIB, "ram_available_bytes": 0}
        )
        == 0
    )

    m3_16g = {
        "is_unified_memory": True,
        "ram_total_bytes": 16 * GIB,
        "ram_available_bytes": 12 * GIB,
        "metal_wired_limit_bytes": int(11.2 * GIB),
    }
    fit = model_fit_analyzer.assess_model_fit(
        {
            "model": qwen3_30b_iq2,
            "hardware": m3_16g,
            "context_length": 4096,
            "safety_reserve_gib": 2.0,
            "execution_profile": "auto_adaptive",
        },
        _ctx(),
    )["value"]
    assert fit["execution_plan"]["num_ctx"] == 4096
    assert QUANT_BPW["F16"] == 16.0
    assert QUANT_BPW["BF16"] == 16.0


def test_cluster_rpc_brackets_ipv6_blocks_imds_and_counts_remote_unified_ram(
    qwen3_30b_iq2: dict[str, Any],
) -> None:
    res = cluster_planner.plan_cluster(
        {
            "model": {
                "download_size_bytes": 40 * GIB,
                "parameter_billions": 70.0,
                "is_moe": False,
                "n_layers": 80,
                "n_kv_heads": 8,
                "head_dim": 128,
            },
            "local_node": {
                "name": "Local-M3",
                "is_unified_memory": True,
                "ram_total_bytes": 16 * GIB,
                "ram_available_bytes": 12 * GIB,
            },
            "workers": [
                {
                    "name": "IPv6-Mac-Studio",
                    "host": "::1",
                    "port": 50052,
                    "is_unified_memory": True,
                    "ram_total_bytes": 64 * GIB,
                    "ram_available_bytes": 50 * GIB,
                    "metal_wired_limit_bytes": int(44.8 * GIB),
                },
                {
                    "name": "IMDS-V4",
                    "host": "169.254.169.254",
                    "port": 80,
                    "ram_available_bytes": 64 * GIB,
                },
                {
                    "name": "IMDS-GCP",
                    "host": "metadata.google.internal",
                    "port": 80,
                    "ram_available_bytes": 64 * GIB,
                },
            ],
            "context_length": 4096,
            "safety_reserve_gib": 2.0,
        },
        _ctx(),
    )["value"]
    assert res["strategy"] == "multi_node_rpc"
    assert "[::1]:50052" in res["runtime_flags"]
    assert all("169.254.169.254" not in f for f in res["runtime_flags"])
    assert all("metadata.google.internal" not in f for f in res["runtime_flags"])
    worker_alloc = next(a for a in res["node_allocations"] if a["name"] == "IPv6-Mac-Studio")
    assert worker_alloc["budget_bytes"] == 49 * GIB

    zero_vram = cluster_planner.plan_cluster(
        {
            "model": qwen3_30b_iq2,
            "local_node": {
                "is_unified_memory": False,
                "vram_bytes": 0,
                "ram_available_bytes": int(1.5 * GIB),
            },
            "safety_reserve_gib": 2.0,
        },
        _ctx(),
    )["value"]
    assert zero_vram["tier1_gpu_bytes"] == 0
    assert "999" not in zero_vram["runtime_flags"]


def test_hardware_analyzer_nvidia_smi_comma_in_gpu_name(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Proc:
        returncode = 0
        stdout = "0, NVIDIA H100, PCIe, 81559, 80000\n"

    monkeypatch.setattr(hardware_analyzer.shutil, "which", lambda _name: "/usr/bin/nvidia-smi")
    monkeypatch.setattr(hardware_analyzer.subprocess, "run", lambda *a, **kw: _Proc())
    gpus = hardware_analyzer._probe_nvidia_smi()
    assert len(gpus) == 1
    assert gpus[0]["model"] == "NVIDIA H100, PCIe"
    assert gpus[0]["vram_total_bytes"] == 81559 * 1024**2
    assert gpus[0]["vram_free_bytes"] == 80000 * 1024**2
