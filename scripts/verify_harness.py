#!/usr/bin/env python3
"""Multi-tier verification harness for MOSAIC (Rust, Python, Frontend, Packaging, Quality, E2E)."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ALL_TIERS = ("rust", "python", "frontend", "packaging", "quality", "e2e")
CHROME_PATH = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
SKILL_LINE_CHECK = Path(
    "/Users/arronkianparejas/.gemini/config/plugins/skill-builder/skills/"
    "world-class-engineering/scripts/check_source_line_limits.py"
)
SKILL_SLOP_CHECK = Path(
    "/Users/arronkianparejas/.gemini/config/plugins/skill-builder/skills/"
    "anti-slop/scripts/sanitize_ai_slop.py"
)


@dataclass
class CheckResult:
    tier: str
    name: str
    status: str  # "pass" | "fail" | "warn"
    duration_s: float
    command: str
    summary: str
    output_tail: str = ""


def run_cmd(cmd: List[str], cwd: Path, env: Optional[Dict[str, str]] = None) -> Tuple[int, str]:
    merged = os.environ.copy()
    if env:
        merged.update(env)
    proc = subprocess.run(cmd, cwd=cwd, env=merged, capture_output=True, text=True, check=False)
    combined = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
    return proc.returncode, combined.strip()


def tail_lines(text: str, limit: int = 20) -> str:
    lines = text.splitlines()
    return "\n".join(lines[-limit:]) if lines else ""


def resolve_python_runner(repo: Path, venv_override: Optional[str]) -> Tuple[List[str], List[str], str]:
    candidates: List[Path] = []
    if venv_override:
        candidates.append(Path(venv_override))
    if os.environ.get("MOSAIC_PYTHON_VENV"):
        candidates.append(Path(os.environ["MOSAIC_PYTHON_VENV"]))
    candidates.append(repo / "python-analytics" / ".venv")

    rc, common_dir = run_cmd(["git", "rev-parse", "--git-common-dir"], repo)
    if rc == 0 and common_dir:
        common_path = Path(common_dir)
        if not common_path.is_absolute():
            common_path = (repo / common_path).resolve()
        candidates.append(common_path.parent / "python-analytics" / ".venv")

    for venv in candidates:
        pytest_bin = venv / "bin" / "pytest"
        ruff_bin = venv / "bin" / "ruff"
        if pytest_bin.exists() and ruff_bin.exists():
            return ([str(pytest_bin)], [str(ruff_bin)], str(venv))

    if shutil.which("uv"):
        return (["uv", "run", "pytest"], ["uv", "run", "ruff"], "uv-run")
    raise RuntimeError("No Python .venv (pytest/ruff) or uv runner found.")


def tier_rust(repo: Path, cargo_target_dir: Optional[str]) -> List[CheckResult]:
    results: List[CheckResult] = []
    crate_dir = repo / "src-tauri"
    target_args = ["--target-dir", cargo_target_dir] if cargo_target_dir else []
    for name, args in [
        ("cargo-test", ["cargo", "test", *target_args]),
        ("cargo-clippy", ["cargo", "clippy", *target_args, "--all-targets", "--", "-D", "warnings"]),
    ]:
        t0 = time.monotonic()
        rc, out = run_cmd(args, crate_dir)
        results.append(
            CheckResult(
                tier="rust", name=name, status="pass" if rc == 0 else "fail",
                duration_s=round(time.monotonic() - t0, 2), command=" ".join(args),
                summary=f"exit={rc}", output_tail=tail_lines(out),
            )
        )
    return results


def tier_python(repo: Path, venv_override: Optional[str]) -> List[CheckResult]:
    pytest_cmd, ruff_cmd, runner_desc = resolve_python_runner(repo, venv_override)
    py_dir = repo / "python-analytics"
    env = {"PYTHONPATH": str(py_dir / "src")}
    results: List[CheckResult] = []
    for name, cmd in [
        ("pytest", [*pytest_cmd, "-v", "-o", "cache_dir=/tmp/mosaic_pytest_cache", "tests"]),
        ("ruff", [*ruff_cmd, "check", "--no-cache", "src", "tests"]),
    ]:
        t0 = time.monotonic()
        rc, out = run_cmd(cmd, py_dir, env=env)
        results.append(
            CheckResult(
                tier="python", name=name, status="pass" if rc == 0 else "fail",
                duration_s=round(time.monotonic() - t0, 2), command=" ".join(cmd),
                summary=f"runner={runner_desc} exit={rc}", output_tail=tail_lines(out),
            )
        )
    return results


def tier_frontend(repo: Path) -> List[CheckResult]:
    results: List[CheckResult] = []
    for name, cmd in [("pnpm-build", ["pnpm", "build"]), ("pnpm-test", ["pnpm", "test"])]:
        t0 = time.monotonic()
        rc, out = run_cmd(cmd, repo)
        results.append(
            CheckResult(
                tier="frontend", name=name, status="pass" if rc == 0 else "fail",
                duration_s=round(time.monotonic() - t0, 2), command=" ".join(cmd),
                summary=f"exit={rc}", output_tail=tail_lines(out),
            )
        )
    return results


def tier_packaging(repo: Path, mode: str) -> List[CheckResult]:
    results: List[CheckResult] = []
    resources_dir = repo / "src-tauri" / "resources"
    existed_before = resources_dir.exists()
    ign_rc, _ = run_cmd(["git", "check-ignore", "-q", "src-tauri/resources"], repo)
    is_ignored = ign_rc == 0

    t0 = time.monotonic()
    rc, out = run_cmd([sys.executable, "scripts/bundle_python_analytics.py"], repo)
    staged_root = resources_dir / "python-analytics"
    required = [
        staged_root / "src" / "mosaic_analytics" / "__main__.py",
        staged_root / "pyproject.toml",
    ]
    if shutil.which("uv"):
        required.append(staged_root / "requirements.pinned.txt")
    missing = [str(p.relative_to(repo)) for p in required if not p.exists()]

    if not existed_before and not is_ignored and resources_dir.exists():
        shutil.rmtree(resources_dir)

    bundle_ok = rc == 0 and not missing
    results.append(
        CheckResult(
            tier="packaging", name="bundle-python-analytics",
            status="pass" if bundle_ok else "fail",
            duration_s=round(time.monotonic() - t0, 2),
            command="python3 scripts/bundle_python_analytics.py",
            summary="staged ok" if bundle_ok else f"missing={missing} exit={rc}",
            output_tail=tail_lines(out),
        )
    )

    t1 = time.monotonic()
    conf = json.loads((repo / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    has_resources = bool(conf.get("bundle", {}).get("resources"))
    conf_status = "pass" if has_resources else ("warn" if mode == "baseline" else "fail")
    results.append(
        CheckResult(
            tier="packaging", name="tauri-conf-bundle-resources", status=conf_status,
            duration_s=round(time.monotonic() - t1, 2), command="inspect src-tauri/tauri.conf.json",
            summary="bundle.resources configured" if has_resources else f"bundle.resources missing (mode={mode})",
        )
    )
    return results


def tier_quality(repo: Path) -> List[CheckResult]:
    results: List[CheckResult] = []
    if SKILL_LINE_CHECK.exists():
        t0 = time.monotonic()
        cmd = [sys.executable, str(SKILL_LINE_CHECK), "--path", str(repo), "--show-tiers"]
        rc, out = run_cmd(cmd, repo)
        results.append(
            CheckResult(
                tier="quality", name="line-limits", status="pass" if rc == 0 else "fail",
                duration_s=round(time.monotonic() - t0, 2), command=" ".join(cmd),
                summary=f"exit={rc}", output_tail=tail_lines(out),
            )
        )
    if SKILL_SLOP_CHECK.exists():
        t1 = time.monotonic()
        cmd = [sys.executable, str(SKILL_SLOP_CHECK), "--path", str(repo), "--strict"]
        rc, out = run_cmd(cmd, repo)
        results.append(
            CheckResult(
                tier="quality", name="anti-slop", status="pass" if rc == 0 else "fail",
                duration_s=round(time.monotonic() - t1, 2), command=" ".join(cmd),
                summary=f"exit={rc}", output_tail=tail_lines(out),
            )
        )
    return results


def tier_e2e(repo: Path, mode: str) -> List[CheckResult]:
    results: List[CheckResult] = []
    steps: List[Tuple[str, List[str]]] = [
        ("e2e-typecheck", ["pnpm", "exec", "tsc", "--noEmit", "-p", "tests/e2e/tsconfig.json"]),
        ("e2e-list", ["pnpm", "exec", "playwright", "test", "--list"]),
        (
            "e2e-playwright",
            ["pnpm", "exec", "playwright", "test", "--grep", "@smoke"]
            if mode == "baseline"
            else ["pnpm", "exec", "playwright", "test"],
        ),
    ]
    for name, cmd in steps:
        t0 = time.monotonic()
        rc, out = run_cmd(cmd, repo)
        results.append(
            CheckResult(
                tier="e2e", name=name, status="pass" if rc == 0 else "fail",
                duration_s=round(time.monotonic() - t0, 2), command=" ".join(cmd),
                summary=f"mode={mode} exit={rc}", output_tail=tail_lines(out),
            )
        )
    return results


def write_reports(results: List[CheckResult], json_out: Path, md_out: Path, mode: str, loop_idx: int) -> None:
    payload = {
        "mode": mode, "loop": loop_idx,
        "passed": all(r.status != "fail" for r in results),
        "results": [asdict(r) for r in results],
    }
    json_out.parent.mkdir(parents=True, exist_ok=True)
    md_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    lines = [
        f"# MOSAIC Verification Harness Report (mode={mode}, loop={loop_idx})",
        "",
        "| Tier | Check | Status | Duration (s) | Summary |",
        "|---|---|---|---:|---|",
    ]
    for r in results:
        lines.append(f"| {r.tier} | {r.name} | {r.status.upper()} | {r.duration_s} | {r.summary} |")
    md_out.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_self_check(repo: Path, args: argparse.Namespace) -> int:
    missing_tools = [t for t in ("cargo", "pnpm", "git") if not shutil.which(t)]
    if missing_tools:
        print(f"[FAIL] Missing required tools: {missing_tools}", file=sys.stderr)
        return 2
    if not CHROME_PATH.exists():
        print(f"[WARN] Google Chrome not found at {CHROME_PATH}; Playwright fallback applies.")
    try:
        _, _, py_desc = resolve_python_runner(repo, args.python_venv)
    except RuntimeError as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        return 2

    self_path = Path(__file__).resolve()
    line_count = len(self_path.read_text(encoding="utf-8").splitlines())
    if line_count >= 350:
        print(f"[FAIL] {self_path.name} has {line_count} lines (must be < 350).", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory() as tmp:
        dummy = [CheckResult("self", "dry-run", "pass", 0.01, "self-check", f"python={py_desc}")]
        write_reports(dummy, Path(tmp) / "r.json", Path(tmp) / "r.md", args.mode, 1)

    if SKILL_SLOP_CHECK.exists():
        rc, out = run_cmd([sys.executable, str(SKILL_SLOP_CHECK), "--path", str(self_path), "--strict"], repo)
        if rc != 0:
            print(out, file=sys.stderr)
            return 2

    print(f"[PASS] verify_harness.py self-check ok (lines={line_count}, python={py_desc}).")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MOSAIC reproducible multi-tier verification harness.")
    parser.add_argument("--tier", default="all", help="Comma-separated tiers or 'all'")
    parser.add_argument("--mode", choices=("baseline", "full"), default="full")
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--json-out", default="/tmp/mosaic_verify_report.json")
    parser.add_argument("--md-out", default="/tmp/mosaic_verify_report.md")
    parser.add_argument("--max-loops", type=int, default=1)
    parser.add_argument("--python-venv", default=None)
    parser.add_argument("--cargo-target-dir", default=os.environ.get("MOSAIC_CARGO_TARGET_DIR"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo = Path(__file__).resolve().parents[1]
    if args.max_loops < 1 or args.max_loops > 3:
        print("Error: --max-loops must be between 1 and 3.", file=sys.stderr)
        return 2
    if args.self_check:
        return run_self_check(repo, args)

    tiers = list(ALL_TIERS) if args.tier == "all" else [t.strip() for t in args.tier.split(",") if t.strip()]
    invalid = [t for t in tiers if t not in ALL_TIERS]
    if not tiers or invalid:
        print(f"Error: invalid tier(s): {invalid}", file=sys.stderr)
        return 2

    all_results: List[CheckResult] = []
    for loop_idx in range(1, args.max_loops + 1):
        all_results = []
        try:
            for tier in tiers:
                if tier == "rust":
                    all_results.extend(tier_rust(repo, args.cargo_target_dir))
                elif tier == "python":
                    all_results.extend(tier_python(repo, args.python_venv))
                elif tier == "frontend":
                    all_results.extend(tier_frontend(repo))
                elif tier == "packaging":
                    all_results.extend(tier_packaging(repo, args.mode))
                elif tier == "quality":
                    all_results.extend(tier_quality(repo))
                elif tier == "e2e":
                    all_results.extend(tier_e2e(repo, args.mode))
        except RuntimeError as exc:
            print(f"Tool error: {exc}", file=sys.stderr)
            return 2

        write_reports(all_results, Path(args.json_out), Path(args.md_out), args.mode, loop_idx)
        if all(r.status != "fail" for r in all_results):
            print(f"[PASS] All {len(all_results)} verification check(s) passed in loop {loop_idx}.")
            return 0

    print(f"[FAIL] Verification failed after {args.max_loops} loop(s). See {args.md_out}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
