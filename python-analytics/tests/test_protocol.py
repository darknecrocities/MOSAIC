"""Tests for the versioned NDJSON protocol worker."""

from __future__ import annotations

import io
import json
import threading

from mosaic_analytics import PROTOCOL_VERSION
from mosaic_analytics.protocol import JobContext, NdjsonWorker


def test_ping_handshake_returns_versioned_pong() -> None:
    worker = NdjsonWorker()
    req = json.dumps(
        {
            "protocol_version": PROTOCOL_VERSION,
            "job_id": "job-1",
            "method": "ping",
            "params": {},
        }
    )
    resp = worker.process_line(req)
    assert resp is not None
    assert resp["kind"] == "pong"
    assert resp["job_id"] == "job-1"
    assert resp["protocol_version"] == PROTOCOL_VERSION
    assert resp["payload"]["value"]["service"] == "mosaic-analytics"


def test_rejects_unsupported_protocol_version() -> None:
    worker = NdjsonWorker()
    req = json.dumps(
        {
            "protocol_version": "0.1",
            "job_id": "job-2",
            "method": "ping",
            "params": {},
        }
    )
    resp = worker.process_line(req)
    assert resp is not None
    assert resp["kind"] == "error"
    assert resp["payload"]["error"]["code"] == "UNSUPPORTED_PROTOCOL"


def test_malformed_json_returns_structured_error() -> None:
    worker = NdjsonWorker()
    resp = worker.process_line("{bad json")
    assert resp is not None
    assert resp["kind"] == "error"
    assert resp["payload"]["error"]["code"] == "INVALID_JSON"


def test_cancel_signals_active_job() -> None:
    worker = NdjsonWorker()
    started = threading.Event()
    observed_cancel = threading.Event()

    def long_job(_params: dict, ctx: JobContext) -> dict:
        started.set()
        if ctx.cancel_event.wait(timeout=2.0):
            observed_cancel.set()
        return {"value": {"cancelled": ctx.is_cancelled}, "source": "measured"}

    worker.register("long_job", long_job)

    req_line = json.dumps(
        {
            "protocol_version": PROTOCOL_VERSION,
            "job_id": "job-long",
            "method": "long_job",
            "params": {},
        }
    )
    out = io.StringIO()
    thread = threading.Thread(target=worker.serve, args=(io.StringIO(req_line + "\n"), out))
    thread.start()

    assert started.wait(timeout=1.0)
    cancel_resp = worker.process_line(
        json.dumps(
            {
                "protocol_version": PROTOCOL_VERSION,
                "job_id": "job-cancel",
                "method": "cancel",
                "params": {"target_job_id": "job-long"},
            }
        )
    )
    thread.join(timeout=2.0)

    assert cancel_resp is not None
    assert cancel_resp["payload"]["value"]["cancelled"] is True
    assert observed_cancel.is_set()
