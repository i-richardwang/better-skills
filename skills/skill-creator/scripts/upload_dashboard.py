#!/usr/bin/env python3
"""
Upload a benchmark iteration to the skill dashboard.

Can be invoked two ways:

1. As a post-hook inside aggregate_benchmark.py — call `upload_from_env(...)`,
   which reads `SKILL_DASHBOARD_URL` / `SKILL_DASHBOARD_TOKEN` from the environment
   and fails soft on any error (never raises, never blocks the main workflow).

2. Standalone CLI — explicit upload of an already-aggregated benchmark directory:

       python -m scripts.upload_dashboard <iteration-dir> \\
         --skill-name my-skill --iteration 3 --skill-path path/to/skill

The payload shape matches the `POST /api/uploads` contract:
benchmark.json + per-run grading.json + optional SKILL.md snapshot + git SHA + hostname.
"""

import argparse
import json
import os
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional


# Fallback set for legacy iteration dirs without a manifest. New runs declare
# their configs in iteration-N/manifest.json, so this is only used when manifest
# is absent or has no `configs` field.
DEFAULT_CONFIG_NAMES = {"with_skill", "without_skill", "new_skill", "old_skill"}
MANIFEST_FILE = "manifest.json"


def _get_git_sha(path: Path) -> Optional[str]:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=path,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return None


def _normalize_configuration(name: str) -> Optional[str]:
    """Map the four on-disk config names to the two dashboard values.
    Improve-mode 'new_skill' / 'old_skill' collapse into with/without for storage."""
    if name in ("with_skill", "new_skill"):
        return "with_skill"
    if name in ("without_skill", "old_skill"):
        return "without_skill"
    return None


def _read_json(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def _allowed_configs(benchmark_dir: Path) -> set[str]:
    """Configs to upload, preferring manifest's declared list."""
    manifest_path = benchmark_dir / MANIFEST_FILE
    manifest = _read_json(manifest_path)
    if isinstance(manifest, dict):
        configs = manifest.get("configs")
        if isinstance(configs, list) and configs:
            return set(configs)
    return DEFAULT_CONFIG_NAMES


def collect_runs(benchmark_dir: Path) -> list[dict]:
    """Walk <benchmark_dir>/eval-*/[config]/run-*/grading.json and build the runs array."""
    search_root = benchmark_dir / "runs"
    if not search_root.exists():
        search_root = benchmark_dir

    allowed = _allowed_configs(benchmark_dir)

    runs: list[dict] = []
    for eval_dir in sorted(search_root.glob("eval-*")):
        try:
            eval_id = int(eval_dir.name.split("-", 1)[1])
        except (IndexError, ValueError):
            continue

        eval_name = ""
        meta = _read_json(eval_dir / "eval_metadata.json")
        if isinstance(meta, dict):
            eval_name = meta.get("eval_name") or meta.get("name") or ""

        for config_dir in sorted(p for p in eval_dir.iterdir() if p.is_dir()):
            if config_dir.name not in allowed:
                continue
            configuration = _normalize_configuration(config_dir.name)
            if configuration is None:
                continue

            for run_dir in sorted(config_dir.glob("run-*")):
                try:
                    run_number = int(run_dir.name.split("-", 1)[1])
                except (IndexError, ValueError):
                    continue

                runs.append({
                    "eval_id": eval_id,
                    "eval_name": eval_name,
                    "configuration": configuration,
                    "run_number": run_number,
                    "grading": _read_json(run_dir / "grading.json"),
                })
    return runs


def _read_evals_definition(skill_path: Path) -> Optional[list]:
    """Read evals.json's `evals` array (if present) for upload as iteration snapshot.
    Returns None on any failure; upload still proceeds without the field."""
    evals_path = skill_path / "evals" / "evals.json"
    if not evals_path.exists():
        return None
    try:
        data = json.loads(evals_path.read_text())
    except Exception as e:
        print(
            f"[dashboard] could not parse {evals_path}: {type(e).__name__}: {e}",
            file=sys.stderr,
        )
        return None
    evals = data.get("evals") if isinstance(data, dict) else None
    if evals is None:
        print(
            f"[dashboard] {evals_path} has no top-level 'evals' array; skipping definition upload",
            file=sys.stderr,
        )
    elif not isinstance(evals, list):
        print(
            f"[dashboard] {evals_path} 'evals' is not an array; skipping definition upload",
            file=sys.stderr,
        )
        return None
    return evals if isinstance(evals, list) else None


def build_payload(
    benchmark_dir: Path,
    skill_name: str,
    iteration_number: int,
    skill_path: Optional[Path],
) -> dict:
    benchmark_path = benchmark_dir / "benchmark.json"
    if not benchmark_path.exists():
        raise FileNotFoundError(f"benchmark.json not found at {benchmark_path}")

    benchmark = json.loads(benchmark_path.read_text())

    payload: dict = {
        "skill_name": skill_name,
        "iteration_number": iteration_number,
        "benchmark": benchmark,
        "runs": collect_runs(benchmark_dir),
        "hostname": socket.gethostname(),
    }

    if skill_path:
        skill_md = skill_path / "SKILL.md"
        if skill_md.exists():
            try:
                payload["skill_md"] = skill_md.read_text()
            except Exception:
                pass
        sha = _get_git_sha(skill_path)
        if sha:
            payload["git_commit_sha"] = sha
        evals_def = _read_evals_definition(skill_path)
        if evals_def is not None:
            payload["evals_definition"] = evals_def

    return payload


def upload(dashboard_url: str, token: str, payload: dict, timeout: float = 30.0) -> dict:
    url = dashboard_url.rstrip("/") + "/api/uploads"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def upload_from_env(
    benchmark_dir: Path,
    skill_name: str,
    iteration_number: int,
    skill_path: Optional[Path] = None,
) -> bool:
    """Fail-soft upload: returns True on success, False on skip/failure. Never raises."""
    if os.environ.get("SKILL_DASHBOARD_DISABLED"):
        return False
    url = os.environ.get("SKILL_DASHBOARD_URL")
    token = os.environ.get("SKILL_DASHBOARD_TOKEN")
    if not url or not token:
        return False
    if not skill_name:
        print("[dashboard] skipped: skill_name is empty", file=sys.stderr)
        return False

    try:
        payload = build_payload(benchmark_dir, skill_name, iteration_number, skill_path)
        result = upload(url, token, payload)
        ingested = result.get("runs_ingested", 0) if isinstance(result, dict) else 0
        print(
            f"[dashboard] uploaded '{skill_name}' iteration {iteration_number} "
            f"({ingested} runs) → {url}",
            file=sys.stderr,
        )
        return True
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8")
        except Exception:
            pass
        print(
            f"[dashboard] upload failed: HTTP {e.code} {e.reason} {detail}",
            file=sys.stderr,
        )
        return False
    except Exception as e:
        print(f"[dashboard] upload failed: {type(e).__name__}: {e}", file=sys.stderr)
        return False


def infer_iteration_number(benchmark_dir: Path) -> Optional[int]:
    name = benchmark_dir.name
    if name.startswith("iteration-"):
        try:
            return int(name.split("-", 1)[1])
        except ValueError:
            return None
    return None


def main():
    parser = argparse.ArgumentParser(description="Upload a benchmark iteration to the dashboard")
    parser.add_argument("benchmark_dir", type=Path, help="Path to iteration-N directory")
    parser.add_argument("--skill-name", required=True)
    parser.add_argument("--iteration", type=int, default=None,
                        help="Iteration number (default: inferred from benchmark_dir name)")
    parser.add_argument("--skill-path", type=Path, default=None,
                        help="Path to the skill directory (for SKILL.md snapshot + git SHA)")
    parser.add_argument("--dashboard-url", default=os.environ.get("SKILL_DASHBOARD_URL"))
    parser.add_argument("--token", default=os.environ.get("SKILL_DASHBOARD_TOKEN"))
    args = parser.parse_args()

    if not args.dashboard_url or not args.token:
        print("Missing --dashboard-url / --token (or SKILL_DASHBOARD_URL / SKILL_DASHBOARD_TOKEN env)",
              file=sys.stderr)
        sys.exit(2)

    iteration_number = args.iteration
    if iteration_number is None:
        iteration_number = infer_iteration_number(args.benchmark_dir)
    if iteration_number is None:
        print(f"Cannot infer iteration number from {args.benchmark_dir.name}; pass --iteration N",
              file=sys.stderr)
        sys.exit(2)

    payload = build_payload(
        args.benchmark_dir,
        args.skill_name,
        iteration_number,
        args.skill_path,
    )
    result = upload(args.dashboard_url, args.token, payload)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
