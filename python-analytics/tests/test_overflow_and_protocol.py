"""Regression tests for overflow guards, NDJSON protocol resilience, and C2 micro fixes."""

from __future__ import annotations

import io
import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from unittest.mock import patch

from mosaic_analytics import PROTOCOL_VERSION
from mosaic_analytics import model_fit_analyzer as mfa
from mosaic_analytics.__main__ import build_worker
from mosaic_analytics.benchmark_runner import run_benchmark
from mosaic_analytics.execution_planner import GIB, resolve_memory_budget
from mosaic_analytics.hardware_analyzer import _probe_rocm_smi
from mosaic_analytics.model_fit_analyzer import (
    _estimate_kv_cache,
    assess_model_fit,
    assess_model_fit_batch,
)
from mosaic_analytics.numeric import MAX_SAFE_BYTES, safe_scaled_int
from mosaic_analytics.protocol import JobContext, NdjsonWorker


def test_ndjson_rejects_5000_digit_int_and_stays_alive() -> None:
    worker = build_worker()
    huge_line = (
        '{"protocol_version":"1.0","job_id":"h6","method":"ping","params":{"x":'
        + "9" * 5000
        + "}}"
    )
    bad = worker.process_line(huge_line)
    assert bad is not None
    assert bad["kind"] == "error"
    assert bad["payload"]["error"]["code"] == "INVALID_JSON"

    r_fd, w_fd = os.pipe()
    out = io.StringIO()
    r_stream = os.fdopen(r_fd, "r", encoding="utf-8")
    w_stream = os.fdopen(w_fd, "w", encoding="utf-8")
    thread = threading.Thread(target=worker.serve, args=(r_stream, out))
    thread.start()
    w_stream.write(huge_line + "\n")
    w_stream.write(
        json.dumps({"protocol_version": PROTOCOL_VERSION, "job_id": "ok-1", "method": "ping"})
        + "\n"
    )
    w_stream.close()
    thread.join(timeout=2.0)
    r_stream.close()

    envelopes = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
    assert [e["kind"] for e in envelopes] == ["error", "pong"]
    assert envelopes[0]["payload"]["error"]["code"] == "INVALID_JSON"
    assert envelopes[1]["job_id"] == "ok-1"


def test_serve_emit_guards_nan_and_unserializable_handler_results() -> None:
    worker = NdjsonWorker()
    worker.register("nan_job", lambda _p, _c: {"value": float("nan")})
    worker.register("obj_job", lambda _p, _c: {"value": object()})

    lines = "\n".join(
        json.dumps({"protocol_version": PROTOCOL_VERSION, "job_id": jid, "method": m})
        for jid, m in (("j-nan", "nan_job"), ("j-obj", "obj_job"), ("j-ok", "ping"))
    )
    out = io.StringIO()
    worker.serve(io.StringIO(lines + "\n"), out)
    by_id = {
        e["job_id"]: e
        for e in (json.loads(line) for line in out.getvalue().splitlines() if line.strip())
    }
    assert by_id["j-nan"]["kind"] == "error"
    assert by_id["j-nan"]["payload"]["error"]["code"] == "EXECUTION_ERROR"
    assert by_id["j-obj"]["kind"] == "error"
    assert by_id["j-obj"]["payload"]["error"]["code"] == "EXECUTION_ERROR"
    assert by_id["j-ok"]["kind"] == "pong"


def test_duplicate_job_id_ping_and_overlapping_jobs_preserve_cancel_tracking() -> None:
    worker = NdjsonWorker()
    started = threading.Event()
    observed_cancel = threading.Event()

    def slow_job(_params: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
        started.set()
        if ctx.cancel_event.wait(timeout=2.0):
            observed_cancel.set()
        return {"value": {"cancelled": ctx.is_cancelled}}

    worker.register("slow", slow_job)
    r_fd, w_fd = os.pipe()
    out = io.StringIO()
    r_stream = os.fdopen(r_fd, "r", encoding="utf-8")
    w_stream = os.fdopen(w_fd, "w", encoding="utf-8")
    thread = threading.Thread(target=worker.serve, args=(r_stream, out))
    thread.start()

    w_stream.write(
        json.dumps({"protocol_version": PROTOCOL_VERSION, "job_id": "dup", "method": "slow"}) + "\n"
    )
    w_stream.flush()
    assert started.wait(timeout=2.0)

    w_stream.write(
        json.dumps({"protocol_version": PROTOCOL_VERSION, "job_id": "dup", "method": "ping"}) + "\n"
    )
    w_stream.write(
        json.dumps(
            {
                "protocol_version": PROTOCOL_VERSION,
                "job_id": "c1",
                "method": "cancel",
                "params": {"target_job_id": "dup"},
            }
        )
        + "\n"
    )
    w_stream.close()
    thread.join(timeout=2.0)
    r_stream.close()

    by_pair = {
        (e["job_id"], e["kind"]): e
        for e in (json.loads(line) for line in out.getvalue().splitlines() if line.strip())
    }
    assert ("dup", "pong") in by_pair
    assert by_pair[("c1", "result")]["payload"]["value"]["cancelled"] is True
    assert observed_cancel.is_set()

    ev_b = threading.Event()
    worker._active_jobs["dup"] = ev_b
    worker._run_job("dup", "slow", lambda _p, _c: {"value": 1}, {}, threading.Event())
    assert worker._active_jobs.get("dup") is ev_b


def test_safe_scaled_int_and_extreme_floats_no_overflow(make_ctx) -> None:
    assert safe_scaled_int(1e305, GIB, default=2 * GIB) == MAX_SAFE_BYTES
    assert safe_scaled_int(-1e305, GIB, default=2 * GIB, min_value=0) == 0
    assert safe_scaled_int(1.79e308, 1.03, min_value=1) == MAX_SAFE_BYTES
    assert safe_scaled_int(10**400, 1.03, default=7) == 7
    assert safe_scaled_int(True, GIB, default=2 * GIB) == 2 * GIB
    assert safe_scaled_int(2.0, GIB) == 2 * GIB

    b1 = resolve_memory_budget({"ram_available_bytes": 16 * GIB}, reserve_gib=1e305)
    assert b1.available_budget_bytes == 0
    b2 = resolve_memory_budget({"gpu_vram_bytes": 1.79e308, "ram_available_bytes": 16 * GIB})
    assert 0 < b2.gpu_budget_bytes <= MAX_SAFE_BYTES

    fit = assess_model_fit(
        {
            "model": {
                "download_size_bytes": 1.79e308, "parameter_billions": 1e305,
                "n_layers": 10**400, "n_kv_heads": 8, "head_dim": 128,
            },
            "hardware": {"ram_available_bytes": 16 * GIB},
            "safety_reserve_gib": 1e305, "context_length": 1e308, "num_parallel": 1e308,
        },
        make_ctx("dbl-max"),
    )["value"]
    assert fit["fit_status"] == "Not recommended"

    kv_huge, notes = _estimate_kv_cache({"parameter_billions": 1e305}, 1e308, "f16", 1e308)
    assert kv_huge == MAX_SAFE_BYTES
    assert notes


def test_batch_isolates_poisoned_and_exception_raising_models(monkeypatch, make_ctx) -> None:
    good = {"ollama_name": "qwen2.5:0.5b", "download_size_bytes": 400_000_000}
    huge_layers = {
        "ollama_name": "bad-layers", "download_size_bytes": 2_000_000_000,
        "n_layers": 10**400, "n_kv_heads": 8, "head_dim": 128,
    }
    res_direct = assess_model_fit_batch(
        {"hardware": {"ram_available_bytes": 16 * GIB}, "models": [good, huge_layers]},
        make_ctx("batch-layers"),
    )["value"]["assessments"]
    assert [a["fit_status"] for a in res_direct] == ["Recommended", "Recommended"]

    orig_single = mfa._assess_single_model

    def flaky_single(**kwargs: Any) -> dict[str, Any]:
        if kwargs["model"].get("ollama_name") == "boom":
            raise OverflowError("simulated per-model failure")
        return orig_single(**kwargs)

    monkeypatch.setattr(mfa, "_assess_single_model", flaky_single)
    isolated = assess_model_fit_batch(
        {"hardware": {"ram_available_bytes": 16 * GIB}, "models": [{"ollama_name": "boom"}, good]},
        make_ctx("batch-isolate"),
    )["value"]["assessments"]
    assert isolated[0]["model_id"] == "boom"
    assert isolated[0]["fit_status"] == "Unknown"
    assert any("Malformed model entry" in r for r in isolated[0]["reasons"])
    assert isolated[1]["model_id"] == "qwen2.5:0.5b"
    assert isolated[1]["fit_status"] == "Recommended"


def test_benchmark_bad_num_ctx_and_rocm_non_dict_json(make_ctx) -> None:
    class OkHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            _ = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            body = json.dumps({"load_duration": 1e6, "eval_duration": 1e9, "eval_count": 20})
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))

        def log_message(self, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), OkHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        res = run_benchmark(
            {
                "endpoint": f"http://127.0.0.1:{server.server_address[1]}",
                "model": "qwen2.5:0.5b", "repetitions": 2,
                "context_length": 4096, "options": {"num_ctx": "bad"},
            },
            make_ctx("bad-num-ctx"),
        )["value"]
        assert res["context_length"] == 4096
    finally:
        server.shutdown()
        server.server_close()

    for stdout in ("[]", "null", "123", '{"a":' + "9" * 5000 + "}"):
        proc = subprocess.CompletedProcess(["rocm-smi"], returncode=0, stdout=stdout, stderr="")
        with (
            patch("mosaic_analytics.hardware_analyzer.shutil.which", return_value="rocm-smi"),
            patch("mosaic_analytics.hardware_analyzer.subprocess.run", return_value=proc),
        ):
            assert _probe_rocm_smi() == []
