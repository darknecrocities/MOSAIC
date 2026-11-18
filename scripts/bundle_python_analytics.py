"""Stage isolated python-analytics sources and pinned SBOM for Tauri release bundles."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_PKG = ROOT / "python-analytics" / "src" / "mosaic_analytics"
DEST_DIR = ROOT / "src-tauri" / "resources" / "python-analytics"


def stage_bundle() -> None:
    if DEST_DIR.exists():
        shutil.rmtree(DEST_DIR)
    (DEST_DIR / "src").mkdir(parents=True, exist_ok=True)
    shutil.copytree(SRC_PKG, DEST_DIR / "src" / "mosaic_analytics")
    shutil.copy2(ROOT / "python-analytics" / "pyproject.toml", DEST_DIR / "pyproject.toml")

    main_entry = DEST_DIR / "src" / "mosaic_analytics" / "__main__.py"
    if not (DEST_DIR / "pyproject.toml").is_file() or not main_entry.is_file():
        raise FileNotFoundError(f"Missing staged python-analytics entrypoint at {main_entry}")

    # Export production-only pinned requirements as a lightweight SBOM.
    req_out = DEST_DIR / "requirements.pinned.txt"
    try:
        proc = subprocess.run(
            ["uv", "export", "--no-dev", "--no-hashes", "--format", "requirements-txt"],
            cwd=ROOT / "python-analytics",
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout:
            req_out.write_text(proc.stdout, encoding="utf-8")
        elif proc.stderr:
            print(f"Warning: uv export returned {proc.returncode}: {proc.stderr.strip()}")
    except FileNotFoundError:
        print("Warning: uv not found on PATH; skipping requirements.pinned.txt export")

    print(f"Staged python-analytics bundle at {DEST_DIR}")


if __name__ == "__main__":
    stage_bundle()
