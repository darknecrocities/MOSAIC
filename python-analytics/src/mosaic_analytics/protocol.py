"""Versioned NDJSON stdin/stdout protocol for the MOSAIC Python worker."""

from __future__ import annotations

import json
import queue
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

    def _parse_or_control(
        self, raw_line: str
    ) -> tuple[dict[str, Any] | None, tuple[str, str, HandlerFn, dict[str, Any]] | None]:
        stripped = raw_line.strip()
        if not stripped:
            return None, None
        try:
            req = json.loads(stripped)
        except json.JSONDecodeError as exc:
            return make_envelope(
                job_id="unknown", kind="error", source="unavailable",
                confidence="unknown", error_code="INVALID_JSON",
                error_message=f"Malformed JSON request: {exc.msg}",
            ), None
        if not isinstance(req, dict):
            return make_envelope(
                job_id="unknown", kind="error", source="unavailable",
                confidence="unknown", error_code="INVALID_JSON",
                error_message="Request must be a JSON object",
            ), None

        job_id = str(req.get("job_id") or "unknown")
        version = req.get("protocol_version")
        if version != PROTOCOL_VERSION:
            return make_envelope(
                job_id=job_id, kind="error", source="unavailable",
                confidence="unknown", error_code="UNSUPPORTED_PROTOCOL",
                error_message=f"Expected protocol_version {PROTOCOL_VERSION}, got {version!r}",
            ), None

        method = req.get("method")
        raw_params = req.get("params")
        params = raw_params if isinstance(raw_params, dict) else {}
        if method == "cancel":
            target_id = str(params.get("target_job_id") or job_id)
            cancelled = self.request_cancel(target_id)
            return make_envelope(
                job_id=job_id, kind="result",
                value={"target_job_id": target_id, "cancelled": cancelled},
                source="measured", confidence="high",
            ), None

        handler = self._handlers.get(str(method))
        if handler is None:
            return make_envelope(
                job_id=job_id, kind="error", source="unavailable",
                confidence="unknown", error_code="METHOD_NOT_FOUND",
                error_message=f"Unknown method: {method!r}",
            ), None
        if method == "ping":
            return self._run_job(job_id, "ping", handler, params, threading.Event()), None
        return None, (job_id, str(method), handler, params)

    def _run_job(
        self,
        job_id: str,
        method: str,
        handler: HandlerFn,
        params: dict[str, Any],
        cancel_event: threading.Event,
    ) -> dict[str, Any]:
        try:
            ctx = JobContext(job_id=job_id, cancel_event=cancel_event)
            result = handler(params, ctx)
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

    def process_line(self, raw_line: str) -> dict[str, Any] | None:
        """Parse and execute a single NDJSON request line synchronously."""
        immediate, pending = self._parse_or_control(raw_line)
        if pending is None:
            return immediate
        job_id, method, handler, params = pending
        cancel_event = threading.Event()
        with self._lock:
            self._active_jobs[job_id] = cancel_event
        return self._run_job(job_id, method, handler, params, cancel_event)

    def request_cancel(self, job_id: str) -> bool:
        """Signal cancellation for an active job if running."""
        with self._lock:
            event = self._active_jobs.get(job_id)
            if event is None:
                return False
            event.set()
            return True

    def serve(self, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> None:
        """Run NDJSON read/write loop with background execution so cancel/ping stay live."""
        write_lock = threading.Lock()
        job_queue: queue.Queue[
            tuple[str, str, HandlerFn, dict[str, Any], threading.Event] | None
        ] = queue.Queue()

        def emit(envelope: dict[str, Any]) -> None:
            line_out = json.dumps(envelope) + "\n"
            with write_lock:
                stdout.write(line_out)
                stdout.flush()

        def worker_loop() -> None:
            while True:
                item = job_queue.get()
                if item is None:
                    job_queue.task_done()
                    break
                job_id, method, handler, params, cancel_event = item
                try:
                    emit(self._run_job(job_id, method, handler, params, cancel_event))
                finally:
                    job_queue.task_done()

        worker_thread = threading.Thread(target=worker_loop, daemon=True)
        worker_thread.start()
        try:
            while line := stdin.readline():
                immediate, pending = self._parse_or_control(line)
                if immediate is not None:
                    emit(immediate)
                elif pending is not None:
                    job_id, method, handler, params = pending
                    cancel_event = threading.Event()
                    with self._lock:
                        self._active_jobs[job_id] = cancel_event
                    job_queue.put((job_id, method, handler, params, cancel_event))
        finally:
            job_queue.put(None)
            worker_thread.join()
