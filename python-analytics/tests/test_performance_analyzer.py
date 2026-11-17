"""Unit tests for bottleneck diagnosis in performance_analyzer."""

from __future__ import annotations

import threading

from mosaic_analytics.performance_analyzer import analyze_performance
from mosaic_analytics.protocol import JobContext


def test_flags_hdd_and_cpu_bottlenecks() -> None:
    resp = analyze_performance(
        {
            "fit": {"fit_status": "Borderline", "expected_backend": "cpu_ram"},
            "storage": {"media_kind": "HDD"},
        },
        JobContext(job_id="perf-1", cancel_event=threading.Event()),
    )
    cats = {b["category"] for b in resp["value"]["bottlenecks"]}
    assert {"memory_pressure", "compute_backend", "storage_throughput"} == cats
