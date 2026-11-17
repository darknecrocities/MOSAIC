# Ollama Integration Guide

MOSAIC integrates with Ollama strictly through documented loopback HTTP APIs (`http://127.0.0.1:11434`) and allow-listed CLI invocations.

## Detection & Runtime Modes

- **macOS (`Ollama.app` / CLI)**: MOSAIC checks `/usr/local/bin/ollama`, `/opt/homebrew/bin/ollama`, `/Applications/Ollama.app`, and `launchctl getenv OLLAMA_MODELS`.
- **Windows / Linux**: MOSAIC checks standard `ollama` binary locations and probes `/api/version` with a 3-second connect timeout.

## Configuring `OLLAMA_MODELS`

1. Select and validate an external drive in MOSAIC (`MOSAIC/ollama-models`).
2. Use **External Storage -> Configure OLLAMA_MODELS** and confirm the dialog.
3. MOSAIC writes a backup of the previous `OLLAMA_MODELS` value to `ollama_models_backup.txt` in the application data directory before applying the change.
4. Restart Ollama if it was already running so the daemon picks up the new directory.
