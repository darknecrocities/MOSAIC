"""Shared deterministic hardware and model fixtures for python-analytics tests."""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

import pytest

from mosaic_analytics.model_fit_analyzer import GIB
from mosaic_analytics.protocol import JobContext


@pytest.fixture()
def make_ctx() -> Callable[[str], JobContext]:
    """Return a factory creating uncancelled JobContexts for unit tests."""
    return lambda job_id="test-job": JobContext(job_id=job_id, cancel_event=threading.Event())


@pytest.fixture()
def cpu_8gb() -> dict[str, Any]:
    return {
        "is_unified_memory": False,
        "gpu_vram_bytes": None,
        "ram_total_bytes": 8 * GIB,
        "ram_available_bytes": int(5.5 * GIB),
        "physical_cores": 4,
    }


@pytest.fixture()
def apple_16gb() -> dict[str, Any]:
    return {
        "is_unified_memory": True,
        "ram_total_bytes": 16 * GIB,
        "ram_available_bytes": 13 * GIB,
        "physical_cores": 8,
    }


@pytest.fixture()
def discrete_8gb() -> dict[str, Any]:
    return {
        "is_unified_memory": False,
        "gpu_vram_bytes": 8 * GIB,
        "ram_total_bytes": 16 * GIB,
        "ram_available_bytes": 14 * GIB,
        "physical_cores": 8,
    }


@pytest.fixture()
def qwen3_30b_iq2() -> dict[str, Any]:
    return {
        "ollama_name": "hf.co/unsloth/Qwen3-30B-A3B-GGUF:IQ2_XS",
        "parameter_billions": 30.5,
        "active_parameter_billions": 3.3,
        "is_moe": True,
        "quantization": "IQ2_XS",
        "download_size_bytes": 9_200_000_000,
        "n_layers": 48,
        "n_kv_heads": 4,
        "head_dim": 128,
    }


@pytest.fixture()
def qwen3_30b_iq3() -> dict[str, Any]:
    return {
        "ollama_name": "hf.co/unsloth/Qwen3-30B-A3B-GGUF:IQ3_XXS",
        "parameter_billions": 30.5,
        "active_parameter_billions": 3.3,
        "is_moe": True,
        "quantization": "IQ3_XXS",
        "download_size_bytes": 12_900_000_000,
        "n_layers": 48,
        "n_kv_heads": 4,
        "head_dim": 128,
    }


@pytest.fixture()
def qwen3_30b_q4() -> dict[str, Any]:
    return {
        "ollama_name": "qwen3:30b-a3b",
        "parameter_billions": 30.5,
        "active_parameter_billions": 3.3,
        "is_moe": True,
        "quantization": "Q4_K_M",
        "download_size_bytes": 18_600_000_000,
        "n_layers": 48,
        "n_kv_heads": 4,
        "head_dim": 128,
    }
