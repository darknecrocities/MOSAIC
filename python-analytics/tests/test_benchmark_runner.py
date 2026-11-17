"""Unit tests for benchmark_runner against a loopback 127.0.0.1 mock Ollama server."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from mosaic_analytics.benchmark_runner import run_benchmark
from mosaic_analytics.protocol import JobContext


class _MockOllamaHandler(BaseHTTPRequestHandler):
    call_count = 0

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
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
    server = HTTPServer(("127.0.0.1", 0), _MockOllamaHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        res = run_benchmark(
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
        run_benchmark(
            {"endpoint": "http://192.168.1.10:11434", "model": "llama3.2:1b"},
            JobContext(job_id="bench-2", cancel_event=threading.Event()),
        )
