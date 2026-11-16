# ADR-0002: Mandatory External Drive Model Library

- **Status**: Accepted
- **Date**: 2026-11-16

## Context

Modern quantized language models routinely consume 4 GB to 40+ GB per variant. Silently pulling models onto a user's primary internal drive quickly exhausts system storage and blurs where weights reside.

## Decision

MOSAIC enforces selecting and validating an external HDD or SSD (`MOSAIC/ollama-models`) as a prerequisite for downloading or running models:
1. Track external volumes by **stable OS volume identifier (UUID)** in SQLite rather than relying solely on transient mount paths or drive letters.
2. Never automatically reformat a drive or silently migrate existing Ollama models; present explicit user confirmation and filesystem notices (APFS/NTFS/ext4 recommended; exFAT and HDD performance trade-offs explained clearly).
3. Block model downloads and execution whenever the external library is missing, read-only, disconnected, or lacks capacity—**never** silently fall back to internal storage.
4. Keep hardware inspection and documentation accessible even before a drive is connected.

## Consequences

- Users retain complete physical ownership and visibility over model weights on removable storage.
- MOSAIC must provide a safe removal workflow (`Stop active model -> flush pending I/O -> OS eject`) and immediate lock/recovery guidance on unexpected disconnect.
