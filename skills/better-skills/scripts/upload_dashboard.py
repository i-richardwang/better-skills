#!/usr/bin/env python3
"""
Upload a benchmark iteration to the skill dashboard.

Can be invoked two ways:

1. As a post-hook inside aggregate_benchmark.py — call `upload_from_env(...)`,
   which reads `SKILL_DASHBOARD_URL` / `SKILL_DASHBOARD_TOKEN` from the environment
   and fails soft on any error (never raises, never blocks the main workflow).

2. Manual CLI — explicit upload of an already-aggregated benchmark directory
   via `better-skills upload <iteration-dir> --skill-name my-skill
   --iteration 3 --skill-path path/to/skill`.

The payload shape matches the `POST /api/uploads` contract:
benchmark.json + per-run grading.json + optional SKILL.md snapshot + git SHA + hostname.
"""

import json
import os
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

from .config import ConfigError, load_evals_config


# --- Skill file scanner -----------------------------------------------------
#
# Captures the rest of the skill directory (sub-docs, agents, scripts, refs)
# for each iteration. SKILL.md and evals.json are intentionally NOT included
# here — they ride on their own payload fields (skill_md / evals_definition)
# and have bespoke UI on the dashboard.

_TEXT_EXTENSIONS = frozenset({
    ".md", ".json", ".py", ".txt", ".yml", ".yaml", ".toml",
    ".sh", ".ts", ".tsx", ".js", ".jsx", ".css", ".html",
    ".cfg", ".ini",
})
_EXTENSIONLESS_ALLOWLIST = frozenset({
    "Makefile", "Dockerfile", "LICENSE", "README", "Procfile",
})
_EXCLUDED_DIRS = frozenset({
    ".git", "__pycache__", "node_modules", "dist", "build",
    ".venv", "venv", ".pytest_cache", ".mypy_cache", ".next",
    ".turbo", ".cache", "target", "out",
})
_EXCLUDED_FILES = frozenset({".DS_Store", "Thumbs.db"})
_SECRET_PREFIXES = (".env", "secrets.", "id_rsa")
_SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx")
# Stored on dedicated columns; carving them out avoids redundancy and lets
# the dashboard render them with bespoke UI.
_EXCLUDED_RELATIVE_PATHS = frozenset({"SKILL.md", "evals.json"})

_MAX_FILE_BYTES = 200_000
_MAX_TOTAL_BYTES = 2_000_000
_MAX_FILES = 500


def _is_text_name(name: str) -> bool:
    if name in _EXTENSIONLESS_ALLOWLIST:
        return True
    ext = os.path.splitext(name)[1].lower()
    return ext in _TEXT_EXTENSIONS


def _is_secret_name(name: str) -> bool:
    return name.startswith(_SECRET_PREFIXES) or name.endswith(_SECRET_SUFFIXES)


def _collect_skill_files(skill_path: Path) -> tuple[dict[str, str], list[str]]:
    """Walk skill_path, return (files_map, warnings).

    Keys are forward-slash relative paths. Symlinks are not followed. Three
    caps apply (per-file, total, entry count); when any is hit we stop and
    record a warning rather than failing the upload.
    """
    files: dict[str, str] = {}
    warnings: list[str] = []
    total_bytes = 0
    root = skill_path.resolve()

    # Sorted traversal so size-cap truncation is deterministic.
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d not in _EXCLUDED_DIRS)
        for name in sorted(filenames):
            if name in _EXCLUDED_FILES or _is_secret_name(name):
                continue
            if not _is_text_name(name):
                continue

            abs_path = Path(dirpath) / name
            try:
                rel = abs_path.relative_to(root).as_posix()
            except ValueError:
                continue
            if rel in _EXCLUDED_RELATIVE_PATHS:
                continue

            try:
                size = abs_path.stat().st_size
            except OSError:
                continue

            if size > _MAX_FILE_BYTES:
                warnings.append(
                    f"skipped {rel}: {size} bytes > {_MAX_FILE_BYTES} per-file cap"
                )
                continue

            if len(files) >= _MAX_FILES:
                warnings.append(
                    f"truncated at {rel}: > {_MAX_FILES} entries cap"
                )
                return files, warnings

            if total_bytes + size > _MAX_TOTAL_BYTES:
                warnings.append(
                    f"truncated at {rel}: total > {_MAX_TOTAL_BYTES} bytes cap"
                )
                return files, warnings

            try:
                content = abs_path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError) as e:
                warnings.append(f"skipped {rel}: {type(e).__name__}")
                continue

            if "\x00" in content:
                warnings.append(f"skipped {rel}: contains NULL byte")
                continue

            files[rel] = content
            total_bytes += size

    return files, warnings


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


def _read_json(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


_ALLOWED_CONFIGS = frozenset({"current", "baseline"})


def collect_runs(benchmark_dir: Path) -> list[dict]:
    """Walk <benchmark_dir>/eval-*/{current,baseline}/run-*/grading.json
    and build the runs array. The two-config layout is fixed — anything else
    in the eval dir is skipped.
    """
    runs: list[dict] = []
    for eval_dir in sorted(benchmark_dir.glob("eval-*")):
        try:
            eval_id = int(eval_dir.name.split("-", 1)[1])
        except (IndexError, ValueError):
            continue

        eval_name = ""
        meta = _read_json(eval_dir / "eval_metadata.json")
        if isinstance(meta, dict):
            eval_name = meta.get("eval_name") or meta.get("name") or ""

        for config_dir in sorted(p for p in eval_dir.iterdir() if p.is_dir()):
            if config_dir.name not in _ALLOWED_CONFIGS:
                continue
            config = config_dir.name

            for run_dir in sorted(config_dir.glob("run-*")):
                try:
                    run_number = int(run_dir.name.split("-", 1)[1])
                except (IndexError, ValueError):
                    continue

                runs.append({
                    "eval_id": eval_id,
                    "eval_name": eval_name,
                    "configuration": config,
                    "run_number": run_number,
                    "grading": _read_json(run_dir / "grading.json"),
                })
    return runs


def _read_evals_definition(skill_path: Path) -> Optional[dict]:
    """Read evals.json for upload as iteration snapshot. Lets the dashboard
    render the actual case prompts alongside results.

    Goes through the pydantic loader so the upload payload is the schema's
    canonical shape — never raw user fields outside the declared schema.
    Returns None on any failure; upload still proceeds without the field."""
    evals_path = skill_path / "evals.json"
    if not evals_path.exists():
        return None
    try:
        return load_evals_config(evals_path).model_dump(exclude_none=True)
    except ConfigError as e:
        print(f"[dashboard] {e}", file=sys.stderr)
        return None


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
        files, file_warnings = _collect_skill_files(skill_path)
        if files:
            payload["skill_files"] = files
        for w in file_warnings:
            print(f"[dashboard] {w}", file=sys.stderr)

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


