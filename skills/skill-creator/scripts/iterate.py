#!/usr/bin/env python3
"""End-to-end iteration orchestrator for skill-creator.

Wraps the full per-iteration ritual into one command:

  1. (if --baseline-mode old_skill) Auto-snapshot the skill into
     <workspace>/skill-snapshot/ when no snapshot exists yet.
  2. Plan + run executors and graders via run_functional_eval.run_all,
     writing iteration-N/manifest.json and per-run run_status.json.
  3. Aggregate into iteration-N/benchmark.json and benchmark.md (which also
     fires the silent dashboard upload if SKILL_DASHBOARD_URL/TOKEN are set).
  4. Launch the eval-viewer in the background unless --no-view, printing
     viewer_pid so the agent can kill it later.

The underlying scripts (run_functional_eval, aggregate_benchmark, viewer)
remain independently invokable for advanced use — `iterate` is the default
path, not a replacement.

Usage:
    python -m scripts.iterate \\
      --skill-path path/to/skill \\
      --workspace path/to/workspace \\
      --iteration 1 \\
      --baseline-mode without_skill

    # Resume after a crash; only re-runs un-graded runs:
    python -m scripts.iterate ... --resume
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

try:
    from . import aggregate_benchmark
    from . import run_functional_eval
except ImportError:
    import aggregate_benchmark  # type: ignore
    import run_functional_eval  # type: ignore


def resolve_evals_json(skill_path: Path, override: Path | None) -> Path:
    if override:
        return override.resolve()
    default = skill_path / "evals" / "evals.json"
    return default.resolve()


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
    # Open + close in the parent — Popen dups the fd into the child, so the
    # parent's handle isn't needed once the child is launched.
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


def main():
    parser = argparse.ArgumentParser(
        description="Orchestrate one full iteration: run + grade + aggregate + view.",
    )
    parser.add_argument("--skill-path", required=True,
                        help="Path to the skill directory under iteration.")
    parser.add_argument("--workspace", required=True,
                        help="Workspace directory; iteration-N/ goes inside.")
    parser.add_argument("--iteration", type=int, required=True)
    parser.add_argument("--baseline-mode", choices=["without_skill", "old_skill"], required=True,
                        help="without_skill: bare baseline. old_skill: compare against snapshot.")
    parser.add_argument("--evals-json", default=None,
                        help="Path to evals.json (default: <skill-path>/evals/evals.json).")
    parser.add_argument("--snapshot-path", default=None,
                        help="Old-skill snapshot path. Defaults to <workspace>/skill-snapshot/, "
                             "auto-created from --skill-path if missing.")
    parser.add_argument("--num-workers", type=int,
                        default=run_functional_eval.DEFAULT_WORKERS)
    parser.add_argument("--default-timeout", type=int,
                        default=run_functional_eval.DEFAULT_TIMEOUT)
    parser.add_argument("--runs-per-config", type=int, default=1)
    parser.add_argument("--model", default=None)
    parser.add_argument("--phase", choices=["all", "executor", "grader"], default="all",
                        help="Pass-through to run_functional_eval. 'all' = full pipeline.")
    parser.add_argument("--grader-md", default=None,
                        help="Override path to agents/grader.md.")
    parser.add_argument("--resume", action="store_true",
                        help="Skip runs already completed (read from run_status.json).")
    parser.add_argument("--skill-name", default=None,
                        help="Skill identifier for manifest + benchmark + dashboard upload. "
                             "Defaults to skill directory name.")
    parser.add_argument("--no-view", action="store_true",
                        help="Skip launching the eval-viewer.")
    parser.add_argument("--no-aggregate", action="store_true",
                        help="Skip benchmark aggregation (and viewer, since it needs benchmark.json).")
    parser.add_argument("--previous-iteration", type=int, default=None,
                        help="Pass <workspace>/iteration-<N>/ to viewer as --previous-workspace.")
    args = parser.parse_args()

    skill_path = Path(args.skill_path).resolve()
    workspace = Path(args.workspace).resolve()
    skill_name = args.skill_name or skill_path.name
    evals_json = resolve_evals_json(skill_path, Path(args.evals_json) if args.evals_json else None)

    if not evals_json.exists():
        print(f"[error] evals.json not found at {evals_json}", file=sys.stderr)
        sys.exit(2)

    # 1 + 2: snapshot (auto inside run_all) + executors + graders + manifest
    summary = run_functional_eval.run_all(
        evals_json=evals_json,
        skill_path=skill_path,
        workspace=workspace,
        iteration=args.iteration,
        baseline_mode=args.baseline_mode,
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

        # Mirror aggregate_benchmark.main()'s fire-and-forget dashboard upload.
        try:
            from .upload_dashboard import upload_from_env
        except ImportError:
            from upload_dashboard import upload_from_env  # type: ignore
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

    output = {
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
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
