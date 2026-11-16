"""Entry point for the MOSAIC Python analytics NDJSON worker."""

from __future__ import annotations

from mosaic_analytics.hardware_analyzer import analyze_hardware
from mosaic_analytics.protocol import NdjsonWorker


def build_worker() -> NdjsonWorker:
    """Create and configure the analytics worker with supported handlers."""
    worker = NdjsonWorker()
    worker.register("analyze_hardware", analyze_hardware)
    return worker


def main() -> None:
    """Serve versioned NDJSON requests over stdin/stdout."""
    build_worker().serve()


if __name__ == "__main__":
    main()
