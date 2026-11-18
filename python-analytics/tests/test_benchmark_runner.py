"""Unit tests for benchmark_runner against a loopback 127.0.0.1 mock Ollama server."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

from mosaic_analytics import benchmark_runner
from mosaic_analytics.protocol import JobContext


class _MockOllamaHandler(BaseHTTPRequestHandler):
    call_count = 0
    captured_bodies: list[dict[str, Any]] = []

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        _MockOllamaHandler.captured_bodies.append(body)
        if body.get("keep_alive") == 0:
            self._send_json({"done": True})
            return

        _MockOllamaHandler.call_count += 1
        load_ns = 900_000_000 if _MockOllamaHandler.call_count == 1 else 50_000_000
        self._send_json(
            {
                "done": True,
                "load_duration": load_ns,
                "prompt_eval_duration": 120_000_000,
                "eval_duration": 1_000_000_000,
                "eval_count": 40,
            }
        )

    def _send_json(self, payload: dict) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def test_benchmark_separates_cold_and_warm_load() -> None:
    _MockOllamaHandler.call_count = 0
    _MockOllamaHandler.captured_bodies = []
    server = HTTPServer(("127.0.0.1", 0), _MockOllamaHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        res = benchmark_runner.run_benchmark(
            {"endpoint": f"http://127.0.0.1:{port}", "model": "llama3.2:1b", "repetitions": 3},
            JobContext(job_id="bench-1", cancel_event=threading.Event()),
        )
    finally:
        server.shutdown()

    val = res["value"]
    assert val["cold_load_ms"] == 900.0
    assert val["warm_load_ms"]["median"] == 50.0
    assert val["ttft_ms"]["median"] == 120.0
    assert val["generation_tok_per_sec"]["median"] == 40.0


def test_rejects_non_loopback_endpoint() -> None:
    with pytest.raises(ValueError, match="loopback"):
        benchmark_runner.run_benchmark(
            {"endpoint": "http://192.168.1.10:11434", "model": "llama3.2:1b"},
            JobContext(job_id="bench-2", cancel_event=threading.Event()),
        )


def test_benchmark_forwards_adaptive_options_and_keep_alive() -> None:
    _MockOllamaHandler.call_count = 0
    _MockOllamaHandler.captured_bodies = []
    server = HTTPServer(("127.0.0.1", 0), _MockOllamaHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        res = benchmark_runner.run_benchmark(
            {
                "endpoint": f"http://127.0.0.1:{port}",
                "model": "qwen3:30b-a3b",
                "repetitions": 2,
                "context_length": 4096,
                "keep_alive": "5m",
                "options": {
                    "num_gpu": 32,
                    "num_batch": 256,
                    "num_ubatch": 128,
                    "num_thread": 8,
                    "use_mmap": True,
                    "use_mlock": False,
                    "ignored_flag": "nope",
                },
            },
            JobContext(job_id="bench-opts", cancel_event=threading.Event()),
        )
    finally:
        server.shutdown()

    trial_body = _MockOllamaHandler.captured_bodies[1]
    assert trial_body["keep_alive"] == "5m"
    assert trial_body["options"]["num_gpu"] == 32
    assert trial_body["options"]["num_batch"] == 256
    assert trial_body["options"]["num_thread"] == 8
    assert "ignored_flag" not in trial_body["options"]
    assert res["value"]["applied_options"]["use_mlock"] is False


def test_benchmark_adaptive_timeouts_and_cancellation(monkeypatch) -> None:
    timeouts: list[float] = []

    def fake_post(_url: str, payload: dict[str, Any], timeout_s: float = 60.0) -> dict[str, Any]:
        if payload.get("keep_alive") == 0:
            return {"done": True}
        timeouts.append(timeout_s)
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
            "model_size_bytes": 19_000_000_000,
            "media_kind": "HDD",
            "warm_load_timeout_s": 90.0,
        },
        JobContext(job_id="bench-to", cancel_event=threading.Event()),
    )
    assert timeouts[0] > 180.0
    assert timeouts[1] == 90.0
    assert res["value"]["cold_load_timeout_s"] == timeouts[0]

    cancel_ev = threading.Event()
    cancel_ev.set()
    cancelled = benchmark_runner.run_benchmark(
        {"endpoint": "http://127.0.0.1:11434", "model": "qwen3:30b-a3b"},
        JobContext(job_id="bench-cancel", cancel_event=cancel_ev),
    )
    assert cancelled["value"]["cancelled"] is True
