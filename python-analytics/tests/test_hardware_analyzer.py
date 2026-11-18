"""Hardware-independent unit tests for mosaic_analytics.hardware_analyzer."""

from __future__ import annotations

import json
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
    monkeypatch.setattr(hardware_analyzer, "_probe_nvidia_smi", lambda: [])
    monkeypatch.setattr(hardware_analyzer, "_probe_rocm_smi", lambda: [])
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
    assert result["value"]["metal_wired_limit_bytes"] is None


def test_apple_silicon_does_not_double_count_vram(monkeypatch) -> None:
    monkeypatch.setattr(hardware_analyzer.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(hardware_analyzer.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(hardware_analyzer.platform, "processor", lambda: "arm")
    monkeypatch.setattr(hardware_analyzer, "_probe_nvidia_nvml", lambda: [])
    monkeypatch.setattr(hardware_analyzer, "_probe_nvidia_smi", lambda: [])
    monkeypatch.setattr(hardware_analyzer, "_probe_rocm_smi", lambda: [])
    monkeypatch.setattr(
        hardware_analyzer.subprocess,
        "run",
        lambda *_a, **_kw: SimpleNamespace(returncode=1, stdout=""),
    )

    result = hardware_analyzer.analyze_hardware({}, _ctx())
    gpu = result["value"]["gpu"]
    assert gpu["status"] == "unified_memory"
    assert gpu["unified_memory"] is True
    assert gpu["devices"][0]["vram_total_bytes"] is None
    assert result["value"]["memory"]["is_unified_memory"] is True


def test_apple_silicon_sysctl_brand_and_metal_wired_limit(monkeypatch) -> None:
    monkeypatch.setattr(hardware_analyzer.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(hardware_analyzer.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(hardware_analyzer, "_probe_nvidia_nvml", lambda: [])
    monkeypatch.setattr(hardware_analyzer, "_probe_nvidia_smi", lambda: [])
    monkeypatch.setattr(hardware_analyzer, "_probe_rocm_smi", lambda: [])
    monkeypatch.setattr(
        hardware_analyzer.psutil,
        "virtual_memory",
        lambda: SimpleNamespace(total=16 * 1024**3, available=8 * 1024**3, percent=50.0),
    )

    def fake_sysctl(cmd: list[str], **_kw) -> SimpleNamespace:
        if "machdep.cpu.brand_string" in cmd:
            return SimpleNamespace(returncode=0, stdout="Apple M3\n")
        if "iogpu.wired_limit_mb" in cmd:
            return SimpleNamespace(returncode=0, stdout="11264\n")
        return SimpleNamespace(returncode=1, stdout="")

    monkeypatch.setattr(hardware_analyzer.subprocess, "run", fake_sysctl)
    res = hardware_analyzer.analyze_hardware(
        {"system_profile": {"ram_available_bytes": 1 * 1024**3}}, _ctx()
    )["value"]

    assert res["gpu"]["devices"][0]["model"] == "Apple M3"
    assert res["metal_wired_limit_bytes"] == 11264 * 1024 * 1024
    assert res["ram_effective_avail_bytes"] == 8 * 1024**3


def test_nvidia_smi_and_rocm_smi_fallbacks(monkeypatch) -> None:
    monkeypatch.setattr(hardware_analyzer.platform, "system", lambda: "Linux")
    monkeypatch.setattr(hardware_analyzer.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(hardware_analyzer, "_probe_nvidia_nvml", lambda: [])
    monkeypatch.setattr(
        hardware_analyzer.psutil,
        "virtual_memory",
        lambda: SimpleNamespace(total=32 * 1024**3, available=20 * 1024**3, percent=37.5),
    )

    monkeypatch.setattr(
        hardware_analyzer.shutil,
        "which",
        lambda name: "/usr/bin/nvidia-smi" if name == "nvidia-smi" else None,
    )
    monkeypatch.setattr(
        hardware_analyzer.subprocess,
        "run",
        lambda *_a, **_kw: SimpleNamespace(
            returncode=0, stdout="0, NVIDIA RTX 4090, 24564, 23100\n"
        ),
    )
    nv_res = hardware_analyzer.analyze_hardware({}, _ctx())["value"]["gpu"]
    assert nv_res["status"] == "measured"
    assert nv_res["devices"][0]["vendor"] == "nvidia"
    assert nv_res["devices"][0]["vram_total_bytes"] == 24564 * 1024 * 1024

    monkeypatch.setattr(
        hardware_analyzer.shutil,
        "which",
        lambda name: "/usr/bin/rocm-smi" if name == "rocm-smi" else None,
    )
    rocm_payload = json.dumps(
        {
            "card0": {
                "Card Series": "AMD Radeon RX 7900 XTX",
                "VRAM Total Memory (B)": str(24 * 1024**3),
                "VRAM Total Used Memory (B)": str(2 * 1024**3),
            }
        }
    )
    monkeypatch.setattr(
        hardware_analyzer.subprocess,
        "run",
        lambda *_a, **_kw: SimpleNamespace(returncode=0, stdout=rocm_payload),
    )
    amd_res = hardware_analyzer.analyze_hardware({}, _ctx())["value"]["gpu"]
    assert amd_res["devices"][0]["vendor"] == "amd"
    assert amd_res["devices"][0]["vram_free_bytes"] == 22 * 1024**3
