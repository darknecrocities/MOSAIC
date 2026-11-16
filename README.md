# MOSAIC

**Modular Orchestration System for Adaptive Inference Clusters**  
*One model. Many machines.*

MOSAIC is a local-first native desktop control center for discovering, evaluating, downloading, storing, and running local language models through **Ollama**, using a user-selected **external HDD or SSD** as the mandatory model library.

> **Product Promise**: Know what your computer can run. Keep models on your own drive. Run local AI through one desktop application.

---

## Core Principles

- **Local-first**: Prompts and inference remain on your machine unless you explicitly configure a remote endpoint.
- **Hardware-aware**: Model-fit recommendations evaluate measured available RAM, GPU/VRAM, Apple Silicon unified memory (without double-counting), quantization, KV-cache demand, and context length.
- **Storage-transparent**: Model weights live exclusively on your selected external volume (`MOSAIC/ollama-models`). MOSAIC never silently falls back to internal disk for downloads.
- **Safe by default**: Never formats drives, moves models, edits service configuration, or deletes model data without explicit confirmation.
- **Honest estimates**: Clearly separates measured hardware telemetry from estimated memory requirements and exact-device benchmarks.
- **Extensible**: Built first as a reliable single-computer manager while preserving clean interfaces for future multi-node distributed inference.

---

## Architecture

MOSAIC uses a hybrid native-plus-Python architecture packaged in a single desktop application:

| Layer | Technology | Ownership |
| :--- | :--- | :--- |
| **Desktop Shell** | Tauri 2 | Native windowing, app lifecycle, permissions, strict CSP, OS packaging |
| **User Interface** | React 19 + TypeScript | Light, white-first (`#FFFFFF` / `#F5F9FD` / `#69AEEB` / `#2878B8`) workspace |
| **Native System Core** | Rust | Hardware enumeration, external-drive identity/validation/eject, SQLite WAL persistence, Ollama supervision, security guards |
| **Analytics Service** | Python 3.11+ (`uv`) | Hardware capability scoring, KV-cache & model-fit modeling, reproducible TTFT / tok/s benchmarks, report export |
| **Inference Runtime** | Ollama | Local model pulls, inventory, generation, and streaming via loopback REST/CLI |
| **Model Storage** | External HDD / SSD | Mandatory external model directory (`OLLAMA_MODELS`) |

> *Rust operates the machine. Python understands and measures the machine. Ollama runs the models. The external drive stores the model library.*

---

## Supported Platforms

| Platform | Target Architectures | Recommended External Filesystem | Notes |
| :--- | :--- | :--- | :--- |
| **macOS** | Apple Silicon (`arm64`), Intel (`x86_64`) | APFS (exFAT supported with notice) | Unified memory shared between CPU and GPU |
| **Windows** | `x86_64`, `arm64` | NTFS (exFAT supported) | NVIDIA NVML / DXGI GPU telemetry where available |
| **Linux** | `x86_64`, `arm64` | ext4 (exFAT/NTFS via OS drivers) | NVIDIA / ROCm telemetry when drivers are present |

---

## Repository Structure

```text
mosaic/
├── assets/docs/          # Product & Technical Specification (v1.1)
├── docs/
│   ├── adr/              # Architecture Decision Records
│   ├── guides/           # Setup, Ollama integration, and drive troubleshooting
│   └── benchmarks/       # Benchmark methodology & report schemas
├── src/                  # React + TypeScript desktop UI
├── src-tauri/            # Tauri 2 shell, Rust native core, SQLite migrations
└── python-analytics/     # Python 3.11+ analytics & benchmarking worker
```

---

## Development Prerequisites

- **Node.js** `22+` and **pnpm** `9+`
- **Rust** toolchain (`rustc` / `cargo`) + OS prerequisites for [Tauri 2](https://v2.tauri.app/start/prerequisites/)
- **Python** `3.11+` and **uv** (`uv sync` inside `python-analytics/`)
- **Ollama** installed locally (`https://docs.ollama.com/`)

---

## Roadmap

- **Phase 0 — Validation (Milestone A)**: Technical spikes for OS hardware probing, external volume UUID detection, `OLLAMA_MODELS` service verification, and Rust↔Python NDJSON IPC.
- **Phase 1–2 — Foundation & Detection (Milestone B)**: Tauri 2 shell, SQLite persistence, security guards, white/light-blue design system, and external-drive onboarding gate.
- **Phase 3–4 — Library & Fit Advisor (Milestone C–D)**: Curated model catalog, KV-cache/memory fit estimator, streaming pulls/chat, and safe drive ejection.
- **Phase 5–6 — Benchmarks & Beta Hardening (Milestone D–E)**: Cold/warm TTFT and tok/s benchmarking, cross-platform CI, signed installers, and documentation.
- **Phase 7 — Distributed Research**: Multi-device discovery and adaptive model sharding (deferred until single-machine milestones are stable).

For the full specification, see [MOSAIC_Product_and_Technical_Specification_v1.1.docx](assets/docs/MOSAIC_Product_and_Technical_Specification_v1.1.docx).

---

## License

MOSAIC application source code is licensed under the **Apache License, Version 2.0** (see [LICENSE](LICENSE)). Individual language models managed through Ollama remain subject to their respective upstream model licenses.
