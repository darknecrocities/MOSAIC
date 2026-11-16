# ADR-0001: Hybrid Tauri 2, Rust Core, and Python Analytics Architecture

- **Status**: Accepted
- **Date**: 2026-11-16

## Context

MOSAIC requires native OS integration (removable volume UUIDs, safe drive ejection, process supervision, loopback HTTP, SQLite persistence) alongside scientific/hardware analytics (statistical benchmark aggregation, KV-cache & GQA memory modeling, optional NVML/ROCm telemetry).

## Decision

Adopt a four-layer local architecture:
1. **Tauri 2 + React/TypeScript** for the white-first, light-blue desktop UI.
2. **Rust Native Core** as the sole owner of OS hardware probes, external volume management, Ollama service configuration, SQLite WAL persistence, and security boundaries.
3. **Python 3.11+ Analytics Worker** (`mosaic_analytics`) run as a Rust-supervised child process communicating via versioned newline-delimited JSON (NDJSON) over stdin/stdout.
4. **Ollama** as the initial inference runtime on loopback (`127.0.0.1`).

## Consequences

- **Positive**: Rust keeps critical storage/process operations dependable and memory-safe; Python accelerates analytics and benchmarking without exposing an unauthenticated LAN server; SQLite remains lock-free because Rust is the sole writer.
- **Graceful Degradation**: If Python or optional GPU libraries (`pynvml`, `rocm-smi`) are unavailable, core navigation, external drive checks, model listing, and Ollama chat remain functional while advanced analytics report `unavailable`.
- **Packaging**: Release builds must provision an isolated, pinned Python runtime so end users do not need a global Python installation.
