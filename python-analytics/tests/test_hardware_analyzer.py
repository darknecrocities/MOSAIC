"""Hardware-independent unit tests for mosaic_analytics.hardware_analyzer."""

from __future__ import annotations

import threading
from types import SimpleNamespace

from mosaic_analytics import hardware_analyzer
from mosaic_analytics.protocol import JobContext


def _ctx() -> JobContext:
    return JobContext(job_id="hw-1", cancel_event=threading.Event())


def test_missing_nvml_reports_unknown_on_non_apple(monkeypatch) -> None:
    monkeypatch.setattr(hardware_analyzer.platform, "system", lambda: "Linux")
    monkeypatch.setattr(hardware_analyzer.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(hardware_analyzer, "_probe_nvidia_nvml", lambda: [])
    monkeypatch.setattr(
        hardware_analyzer.psutil,
        "virtual_memory",
        lambda: SimpleNamespace(total=16 * 1024**3, available=10 * 1024**3, percent=37.5),
    )

    result = hardware_analyzer.analyze_hardware({}, _ctx())
    gpu = result["value"]["gpu"]
    assert gpu["status"] == "unknown"
    assert gpu["unified_memory"] is False
    assert gpu["devices"] == []
    assert result["value"]["memory"]["is_unified_memory"] is False


def test_apple_silicon_does_not_double_count_vram(monkeypatch) -> None:
    monkeypatch.setattr(hardware_analyzer.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(hardware_analyzer.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(hardware_analyzer.platform, "processor", lambda: "arm")
    monkeypatch.setattr(hardware_analyzer, "_probe_nvidia_nvml", lambda: [])

    result = hardware_analyzer.analyze_hardware({}, _ctx())
    gpu = result["value"]["gpu"]
    assert gpu["status"] == "unified_memory"
    assert gpu["unified_memory"] is True
    assert gpu["devices"][0]["vram_total_bytes"] is None
    assert result["value"]["memory"]["is_unified_memory"] is True
