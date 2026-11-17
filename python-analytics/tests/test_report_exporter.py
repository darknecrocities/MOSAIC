"""Unit tests for report_exporter HTML escaping and CSV/JSON output."""

from __future__ import annotations

import threading

from mosaic_analytics.protocol import JobContext
from mosaic_analytics.report_exporter import export_report


def test_html_export_escapes_script_injection() -> None:
    res = export_report(
        {"format": "html", "report": {"model": "<script>alert(1)</script>"}},
        JobContext(job_id="exp-1", cancel_event=threading.Event()),
    )
    html_out = res["value"]["content"]
    assert "<script>" not in html_out
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html_out


def test_csv_export_outputs_rows() -> None:
    res = export_report(
        {"format": "csv", "report": {"model": "llama3.2:1b", "tok_s": 42.5}},
        JobContext(job_id="exp-2", cancel_event=threading.Event()),
    )
    assert "model,llama3.2:1b" in res["value"]["content"]
