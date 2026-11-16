"""Versioned NDJSON stdin/stdout protocol for the MOSAIC Python worker."""

from __future__ import annotations

import json
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, TextIO

from mosaic_analytics import PROTOCOL_VERSION, __version__


def utc_now_iso() -> str:
    """Return an ISO-8601 UTC timestamp string."""
    return datetime.now(tz=UTC).isoformat()


def make_envelope(
    *,
    job_id: str,
    kind: str,
    value: Any = None,
    unit: str | None = None,
    source: str = "measured",
    confidence: str = "high",
    limitations: list[str] | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
) -> dict[str, Any]:
    """Construct a versioned protocol response envelope."""
    payload: dict[str, Any] = {
        "value": value,
        "unit": unit,
        "source": source,
        "timestamp": utc_now_iso(),
        "confidence": confidence,
        "limitations": limitations or [],
    }
    if error_code is not None or error_message is not None:
        payload["error"] = {
            "code": error_code or "INTERNAL_ERROR",
            "message": error_message or "Unknown analytics error",
        }
    return {
        "protocol_version": PROTOCOL_VERSION,
        "job_id": job_id,
        "kind": kind,
        "payload": payload,
    }


@dataclass
class JobContext:
    """Cancellation-aware context passed to method handlers."""

    job_id: str
    cancel_event: threading.Event

    @property
    def is_cancelled(self) -> bool:
        """Return True when cancellation has been requested for this job."""
        return self.cancel_event.is_set()


HandlerFn = Callable[[dict[str, Any], JobContext], dict[str, Any]]


class NdjsonWorker:
    """Line-delimited JSON worker with version negotiation and cancellation."""

    def __init__(self, handlers: dict[str, HandlerFn] | None = None) -> None:
        self._handlers: dict[str, HandlerFn] = dict(handlers or {})
        self._active_jobs: dict[str, threading.Event] = {}
        self._lock = threading.Lock()
        self._handlers.setdefault("ping", self._handle_ping)

    def register(self, method: str, handler: HandlerFn) -> None:
        """Register a method handler."""
        self._handlers[method] = handler

    @staticmethod
    def _handle_ping(_params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
        return {
            "value": {
                "service": "mosaic-analytics",
                "version": __version__,
                "protocol_version": PROTOCOL_VERSION,
            },
            "unit": None,
            "source": "measured",
            "confidence": "high",
            "limitations": [],
        }

    def process_line(self, raw_line: str) -> dict[str, Any] | None:
        """Parse and execute a single NDJSON request line."""
        stripped = raw_line.strip()
        if not stripped:
            return None

        try:
            req = json.loads(stripped)
        except json.JSONDecodeError as exc:
            return make_envelope(
                job_id="unknown",
                kind="error",
                source="unavailable",
                confidence="unknown",
                error_code="INVALID_JSON",
                error_message=f"Malformed JSON request: {exc.msg}",
            )

        job_id = str(req.get("job_id") or "unknown")
        version = req.get("protocol_version")
        if version != PROTOCOL_VERSION:
            return make_envelope(
                job_id=job_id,
                kind="error",
                source="unavailable",
                confidence="unknown",
                error_code="UNSUPPORTED_PROTOCOL",
                error_message=f"Expected protocol_version {PROTOCOL_VERSION}, got {version!r}",
            )

        method = req.get("method")
        if method == "cancel":
            target_id = str((req.get("params") or {}).get("target_job_id") or job_id)
            cancelled = self.request_cancel(target_id)
            return make_envelope(
                job_id=job_id,
                kind="result",
                value={"target_job_id": target_id, "cancelled": cancelled},
                source="measured",
                confidence="high",
            )

        handler = self._handlers.get(str(method))
        if handler is None:
            return make_envelope(
                job_id=job_id,
                kind="error",
                source="unavailable",
                confidence="unknown",
                error_code="METHOD_NOT_FOUND",
                error_message=f"Unknown method: {method!r}",
            )

        cancel_event = threading.Event()
        with self._lock:
            self._active_jobs[job_id] = cancel_event

        try:
            ctx = JobContext(job_id=job_id, cancel_event=cancel_event)
            result = handler(req.get("params") or {}, ctx)
            kind = "pong" if method == "ping" else "result"
            return make_envelope(
                job_id=job_id,
                kind=kind,
                value=result.get("value"),
                unit=result.get("unit"),
                source=result.get("source", "measured"),
                confidence=result.get("confidence", "high"),
                limitations=result.get("limitations"),
            )
        except Exception as exc:  # noqa: BLE001
            return make_envelope(
                job_id=job_id,
                kind="error",
                source="unavailable",
                confidence="unknown",
                error_code="EXECUTION_ERROR",
                error_message=str(exc),
            )
        finally:
            with self._lock:
                self._active_jobs.pop(job_id, None)

    def request_cancel(self, job_id: str) -> bool:
        """Signal cancellation for an active job if running."""
        with self._lock:
            event = self._active_jobs.get(job_id)
            if event is None:
                return False
            event.set()
            return True

    def serve(self, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> None:
        """Run the blocking NDJSON read/write loop until EOF."""
        for line in stdin:
            response = self.process_line(line)
            if response is None:
                continue
            stdout.write(json.dumps(response) + "\n")
            stdout.flush()
