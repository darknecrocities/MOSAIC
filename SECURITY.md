# Security Policy

## Local-First Security Architecture

MOSAIC is designed around strict local boundaries:

1. **Loopback Isolation**: Ollama and internal analytics IPC communicate strictly over `127.0.0.1` / stdin-stdout by default. LAN exposure is never enabled silently.
2. **Zero Prompt Telemetry**: MOSAIC does not collect prompts, model completions, or model files. Conversation content is not persisted to SQLite by default, and diagnostic exports redact sensitive paths and exclude chat text.
3. **Strict Process & Path Guards**:
   - External commands (`ollama`, OS disk utilities, Python worker) run with validated executable paths and fixed argument lists—never through a shell (`sh -c`, `cmd /C`).
   - All filesystem writes inside the external library are canonicalized and checked against the configured library root boundary.
   - Downloaded model artifacts are never executed as programs.
4. **User Confirmation Gates**: Changing `OLLAMA_MODELS`, migrating existing models, or deleting model weights requires explicit user confirmation.
5. **Tauri Webview Hardening**: Strict Content Security Policy (`default-src 'self'`, no `unsafe-inline` or `unsafe-eval`), framework-native JSX escaping, and zero `dangerouslySetInnerHTML`.

## Reporting a Vulnerability

If you discover a security issue in MOSAIC (such as path traversal, command injection, unintended network exposure, or privilege escalation):

- **Do not** open a public GitHub issue with exploit details.
- Report the vulnerability privately through GitHub Security Advisories (`Security -> Advisories -> Report a vulnerability` on `https://github.com/darknecrocities/MOSAIC`) or contact the repository maintainer directly.
- Include reproduction steps, affected OS/version, and potential impact. We will acknowledge receipt and coordinate a fix before public disclosure.
