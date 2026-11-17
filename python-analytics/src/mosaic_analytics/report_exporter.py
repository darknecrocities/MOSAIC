"""Local-only JSON, CSV, and HTML report exporter (never uploads data)."""

from __future__ import annotations

import csv
import html
import io
import json
from typing import Any

from mosaic_analytics.protocol import JobContext


def export_report(params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
    """Render benchmark/device report into JSON, CSV, or escaped HTML."""
    fmt = str(params.get("format") or "json").lower()
    report = params.get("report") or {}

    if fmt == "json":
        content = json.dumps(report, indent=2)
    elif fmt == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["metric", "value"])
        for key, val in report.items():
            writer.writerow([key, json.dumps(val) if isinstance(val, dict | list) else val])
        content = buf.getvalue()
    elif fmt == "html":
        rows = "".join(
            f"<tr><th>{html.escape(str(k))}</th><td>{html.escape(str(v))}</td></tr>"
            for k, v in report.items()
        )
        content = (
            "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
            "<title>MOSAIC Benchmark Report</title></head>"
            f"<body><h1>MOSAIC Benchmark Report</h1><table>{rows}</table></body></html>"
        )
    else:
        raise ValueError(f"Unsupported export format: {fmt!r}")

    return {
        "value": {"format": fmt, "content": content},
        "unit": None,
        "source": "calculated",
        "confidence": "high",
        "limitations": [],
    }
