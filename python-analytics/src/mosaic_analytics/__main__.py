"""Entry point for the MOSAIC Python analytics NDJSON worker."""

from __future__ import annotations

from mosaic_analytics.benchmark_runner import run_benchmark
from mosaic_analytics.hardware_analyzer import analyze_hardware
from mosaic_analytics.model_fit_analyzer import assess_model_fit
from mosaic_analytics.performance_analyzer import analyze_performance
from mosaic_analytics.protocol import NdjsonWorker
from mosaic_analytics.report_exporter import export_report


def build_worker() -> NdjsonWorker:
    """Create and configure the analytics worker with supported handlers."""
    worker = NdjsonWorker()
    worker.register("analyze_hardware", analyze_hardware)
    worker.register("estimate_fit", assess_model_fit)
    worker.register("analyze_performance", analyze_performance)
    worker.register("run_benchmark", run_benchmark)
    worker.register("export_report", export_report)
    return worker


def main() -> None:
    """Serve versioned NDJSON requests over stdin/stdout."""
    build_worker().serve()


if __name__ == "__main__":
    main()
