# Contributing to MOSAIC

Thank you for contributing to MOSAIC. This project values clear architecture, honest hardware/memory reporting, safe local storage handling, and reviewable commits.

## Development Workflow

1. **Branch from `main`** using a descriptive Conventional prefix:
   - `feat/<scope>` for new capabilities
   - `fix/<scope>` for bug fixes
   - `docs/<scope>` for documentation and ADRs
   - `refactor/<scope>` for structural improvements with no behavior change
   - `chore/<scope>` for build, CI, or dependency maintenance
2. **Keep files modular**:
   - Target 150–250 lines per source file (hard ceiling: 500 lines).
   - Keep functions focused (≤ 40 lines) with shallow nesting and early returns.
3. **Keep commits focused and descriptive**:
   - Limit each commit to **< 1,000 changed lines** (excluding generated lockfiles).
   - Use **Conventional Commits** with a subject line (`<= 72` chars) and a structured body explaining **Context / Why**, **Key Changes / What**, and **Verification / Impact**.
4. **Open a Pull Request against `main`**:
   - Complete the repository PR template checklist.
   - Include exact verification commands and observed test results.

## Coding & Security Standards

- **Zero shell interpolation**: Invoke external binaries via explicit argument vectors only; validate model names and paths before use.
- **Path containment**: Canonicalize and verify filesystem boundaries before reading/writing inside the external model library.
- **Loopback by default**: Local APIs and worker processes must bind only to `127.0.0.1` / `localhost`.
- **Parameterized SQLite**: All SQL statements must use parameter bindings (`?`).
- **No silent internal storage fallback**: Model downloads and execution must remain gated on a validated external volume.
- **No fabricated telemetry**: Report `'unknown'` or `'unavailable'` when hardware probes or GPU vendor libraries are absent.

## Verification Checklist

Before pushing or opening a Pull Request, run the relevant checks for any modified layer:

- **Rust**: `cargo test` and `cargo clippy -- -D warnings` (in `src-tauri/`)
- **Python**: `uv run pytest` and `uv run ruff check` (in `python-analytics/`)
- **Frontend**: `pnpm typecheck` and `pnpm test`
