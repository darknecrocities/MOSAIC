"""Local-only JSON, CSV, and HTML report exporter (never uploads data)."""

from __future__ import annotations

import csv
import html
import io
import json
import math
from typing import Any

from mosaic_analytics.protocol import JobContext

FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _sanitize_json_values(obj: Any) -> Any:
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _sanitize_json_values(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_json_values(v) for v in obj]
    if isinstance(obj, tuple):
        return [_sanitize_json_values(v) for v in obj]
    return obj


def _neutralize_csv_text(text: str) -> str:
    return f"'{text}" if text.startswith(FORMULA_PREFIXES) else text


def _sanitize_csv_cell(val: Any) -> Any:
    if isinstance(val, dict | list):
        return _neutralize_csv_text(json.dumps(_sanitize_json_values(val), allow_nan=False))
    if isinstance(val, float) and not math.isfinite(val):
        return ""
    if isinstance(val, str):
        return _neutralize_csv_text(val)
    return val


def export_report(params: dict[str, Any], _ctx: JobContext) -> dict[str, Any]:
    """Render benchmark/device report into JSON, CSV, or escaped HTML."""
    fmt = str(params.get("format") or "json").lower()
    raw_report = params.get("report")
    if raw_report is None:
        report: dict[str, Any] = {}
    elif isinstance(raw_report, dict):
        report = raw_report
    else:
        raise ValueError("report must be a dictionary")

    clean_report = _sanitize_json_values(report)
    if fmt == "json":
        content = json.dumps(clean_report, indent=2, allow_nan=False)
    elif fmt == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["metric", "value"])
        for key, val in clean_report.items():
            writer.writerow([_neutralize_csv_text(str(key)), _sanitize_csv_cell(val)])
        content = buf.getvalue()
    elif fmt == "html":
        rows = "".join(
            f"<tr><th>{html.escape(str(k))}</th><td>{html.escape(str(v))}</td></tr>"
            for k, v in clean_report.items()
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
