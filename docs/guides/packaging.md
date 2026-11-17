# Packaging & Bundled Python Guide

MOSAIC packages the Tauri 2 desktop shell, React UI, Rust core, and the isolated `python-analytics` service together so end users do not need a global Python setup.

## Staging Python Analytics for Release

1. Stage the isolated analytics package and pinned dependency SBOM:
   ```bash
   python3 scripts/bundle_python_analytics.py
   ```
2. Build the native installer for your target platform:
   ```bash
   pnpm tauri build
   ```
3. At runtime, `python_analytics_service.rs` resolves bundled resources (`../Resources/python-analytics` on macOS, `resources/python-analytics` on Windows/Linux) before falling back to dev `.venv`.
