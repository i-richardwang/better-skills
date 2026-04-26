"""End-to-end iteration orchestrator for skill-creator.

Driven by `scripts.cli iterate`. Wraps the per-iteration ritual:

  1. Auto-snapshot the skill into <workspace>/skill-snapshot/ if any variant
     in evals.json declares mount=snapshot (only when no snapshot exists yet).
  2. Plan + run executors and graders via run_functional_eval.run_all, writing
     iteration-N/manifest.json and per-run run_status.json.
  3. Aggregate into iteration-N/benchmark.json + benchmark.md and fire the
     fail-soft dashboard upload (if SKILL_DASHBOARD_URL/TOKEN are set).
  4. Launch the eval-viewer in the background unless --no-view, returning the
     viewer pid so the agent can kill it later.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

from . import aggregate_benchmark, run_functional_eval
from .config import find_evals_config
from .upload_dashboard import upload_from_env


def launch_viewer(
    iteration_dir: Path,
    skill_name: str,
    benchmark_path: Path,
    previous_iteration_dir: Path | None,
    viewer_log: Path,
) -> int | None:
    """Spawn the viewer as a detached background process. Returns pid or None on failure."""
    viewer_script = (
        Path(__file__).resolve().parent.parent / "eval-viewer" / "generate_review.py"
    )
    if not viewer_script.exists():
        print(f"[viewer] script not found at {viewer_script}; skipping", file=sys.stderr)
        return None

    cmd = [
        sys.executable,
        str(viewer_script),
        str(iteration_dir),
        "--skill-name", skill_name,
        "--benchmark", str(benchmark_path),
    ]
    if previous_iteration_dir and previous_iteration_dir.exists():
        cmd.extend(["--previous-workspace", str(previous_iteration_dir)])

    viewer_log.parent.mkdir(parents=True, exist_ok=True)
    with open(viewer_log, "w") as log_handle:
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError as e:
            print(f"[viewer] failed to launch: {e}", file=sys.stderr)
            return None

    print(
        f"[viewer] launched pid={proc.pid} (logs: {viewer_log}). "
        f"`kill {proc.pid}` to stop.",
        file=sys.stderr,
        flush=True,
    )
    return proc.pid


def run_iteration(args: argparse.Namespace) -> dict:
    """Execute one full iteration. Returns the structured summary dict."""
    skill_path = Path(args.skill_path).resolve()
    workspace = Path(args.workspace).resolve()
    skill_name = args.skill_name or skill_path.name
    evals_json = (
        Path(args.evals_json).resolve() if args.evals_json
        else find_evals_config(skill_path).resolve()
    )
    if not evals_json.exists():
        raise FileNotFoundError(f"evals.json not found at {evals_json}")

    # 1 + 2: snapshot (auto inside run_all) + executors + graders + manifest
    summary = run_functional_eval.run_all(
        evals_json=evals_json,
        skill_path=skill_path,
        workspace=workspace,
        iteration=args.iteration,
        snapshot_path=Path(args.snapshot_path) if args.snapshot_path else None,
        num_workers=args.num_workers,
        default_timeout=args.default_timeout,
        runs_per_config=args.runs_per_config,
        model=args.model,
        phase=args.phase,
        grader_md=Path(args.grader_md) if args.grader_md else None,
        resume=args.resume,
        skill_name=skill_name,
    )

    iteration_dir = Path(summary["iteration_dir"])
    benchmark_path: Path | None = None
    viewer_pid: int | None = None

    # 3: aggregate
    if not args.no_aggregate:
        benchmark = aggregate_benchmark.generate_benchmark(
            iteration_dir,
            skill_name=skill_name,
            skill_path=str(skill_path),
        )
        benchmark_path = iteration_dir / "benchmark.json"
        benchmark_path.write_text(json.dumps(benchmark, indent=2))
        md_path = iteration_dir / "benchmark.md"
        md_path.write_text(aggregate_benchmark.generate_markdown(benchmark))
        print(f"[aggregate] wrote {benchmark_path} and {md_path}", file=sys.stderr, flush=True)

        try:
            upload_from_env(
                benchmark_dir=iteration_dir,
                skill_name=skill_name,
                iteration_number=args.iteration,
                skill_path=skill_path,
            )
        except Exception as e:
            print(f"[dashboard] hook skipped: {e}", file=sys.stderr)

    # 4: viewer
    if not args.no_view and not args.no_aggregate and benchmark_path is not None:
        prev_dir = None
        if args.previous_iteration is not None:
            prev_dir = workspace / f"iteration-{args.previous_iteration}"
        viewer_log = iteration_dir / "viewer.log"
        viewer_pid = launch_viewer(
            iteration_dir=iteration_dir,
            skill_name=skill_name,
            benchmark_path=benchmark_path,
            previous_iteration_dir=prev_dir,
            viewer_log=viewer_log,
        )

    return {
        "status": "complete",
        "iteration": args.iteration,
        "iteration_dir": str(iteration_dir),
        "manifest_path": summary["manifest_path"],
        "benchmark_path": str(benchmark_path) if benchmark_path else None,
        "viewer_pid": viewer_pid,
        "skill_name": skill_name,
        "num_evals": summary["num_evals"],
        "num_runs": summary["num_runs"],
    }
