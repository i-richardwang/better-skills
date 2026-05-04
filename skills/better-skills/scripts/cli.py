#!/usr/bin/env python3
"""better-skills — single CLI surface for the Agent Skills evaluation pipelines.

Subcommands:

  Functional pipeline (test what the skill produces under variants):
    init           Scaffold evals.json + triggers.json templates in a skill dir.
    snapshot       Capture current skill state into <workspace>/skill-snapshot/.
    run            Run executors + graders for one iteration; writes manifest.
    aggregate      Roll per-run grading.json files into benchmark.json + .md.
    iterate        Full pipeline: run + aggregate + upload + view (recommended).
    view           Launch the eval-viewer in the background.

  Trigger pipeline (test whether the description triggers Claude):
    trigger-eval     Run trigger queries against a description.
    trigger-improve  Propose an improved description from prior eval results.
    trigger-loop     Iterative eval+improve loop with train/test split.

Each subcommand prints structured JSON to stdout and progress to stderr. Run
`better-skills <subcommand> --help` for details.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import (
    aggregate_benchmark,
    improve_description,
    iterate,
    run_eval,
    run_functional_eval,
    run_loop,
)
from .config import (
    CaseConfig,
    ConfigError,
    EvalsConfig,
    FunctionalDefaults,
    TriggerQuery,
    TriggersConfig,
    VariantConfig,
    find_evals_config,
)


# --- init -------------------------------------------------------------------
#
# Templates round-trip through the pydantic models so every default value
# (runs_per_variant, timeout_s, trigger_threshold, holdout, ...) lives in
# config.py only. Adding a new default never requires editing this file.


def _evals_template(skill_name: str) -> dict:
    template = EvalsConfig(
        skill_name=skill_name,
        variants=[
            VariantConfig(name="with_skill", mount="self"),
            VariantConfig(name="without_skill", mount="none"),
        ],
        defaults=FunctionalDefaults(
            primary_variant="with_skill",
            baseline_variant="without_skill",
        ),
        cases=[
            CaseConfig(
                id=1,
                name="example case",
                prompt="Replace this with the task you want to test.",
                expectations=["The output contains the expected result."],
            )
        ],
    ).model_dump(exclude_none=True)
    # Drop empty collections from each case so the scaffold stays minimal —
    # users can read the schema doc to discover optional fields like `files`,
    # `env`, `prompt_file`. Defaults block keeps its values (num_workers etc.)
    # since those are pedagogical defaults, not empty placeholders.
    template["cases"] = [
        {k: v for k, v in c.items() if v not in ({}, [])}
        for c in template["cases"]
    ]
    return template


def _triggers_template(skill_name: str) -> dict:
    return TriggersConfig(
        skill_name=skill_name,
        queries=[
            TriggerQuery(query="Example query that should trigger the skill", should_trigger=True),
            TriggerQuery(query="Example unrelated query", should_trigger=False),
        ],
    ).model_dump(exclude_none=True)


def cmd_init(args: argparse.Namespace) -> dict:
    skill_path = Path(args.skill_path).resolve()
    if not skill_path.exists():
        raise SystemExit(f"skill path not found: {skill_path}")

    created: list[str] = []
    skipped: list[str] = []

    evals_path = skill_path / "evals.json"
    if evals_path.exists() and not args.force:
        skipped.append(str(evals_path))
    else:
        evals_path.write_text(json.dumps(_evals_template(skill_path.name), indent=2) + "\n")
        created.append(str(evals_path))

    triggers_path = skill_path / "triggers.json"
    if triggers_path.exists() and not args.force:
        skipped.append(str(triggers_path))
    else:
        triggers_path.write_text(json.dumps(_triggers_template(skill_path.name), indent=2) + "\n")
        created.append(str(triggers_path))

    if created:
        print(
            "[init] If your skill touches external mutable state "
            "(database, browser, sandbox, webhook receiver, port), "
            "see references/evals-schema.md → \"Advanced: per_run_setup\" "
            "for symptom-led recipes. Most skills don't need it.",
            file=sys.stderr,
            flush=True,
        )

    return {"status": "ok", "created": created, "skipped": skipped}


# --- snapshot ---------------------------------------------------------------


def cmd_snapshot(args: argparse.Namespace) -> dict:
    skill_path = Path(args.skill_path).resolve()
    workspace = Path(args.workspace).resolve()
    snapshot_path = (
        Path(args.snapshot_path).resolve() if args.snapshot_path
        else workspace / "skill-snapshot"
    )
    if snapshot_path.exists() and not args.force:
        return {
            "status": "exists",
            "snapshot_path": str(snapshot_path),
            "message": "snapshot already exists; pass --force to overwrite",
        }
    if snapshot_path.exists() and args.force:
        import shutil
        shutil.rmtree(snapshot_path)
    run_functional_eval._ensure_snapshot(skill_path, snapshot_path)
    return {"status": "created", "snapshot_path": str(snapshot_path)}


# --- run --------------------------------------------------------------------


def cmd_run(args: argparse.Namespace) -> dict:
    skill_path = Path(args.skill_path).resolve()
    workspace = Path(args.workspace).resolve()
    evals_json = (
        Path(args.evals_json).resolve() if args.evals_json
        else find_evals_config(skill_path).resolve()
    )
    return run_functional_eval.run_all(
        evals_json=evals_json,
        skill_path=skill_path,
        workspace=workspace,
        iteration=args.iteration,
        snapshot_path=Path(args.snapshot_path).resolve() if args.snapshot_path else None,
        num_workers=args.num_workers,
        default_timeout=args.default_timeout,
        runs_per_config=args.runs_per_config,
        phase=args.phase,
        grader_md=Path(args.grader_md).resolve() if args.grader_md else None,
        resume=args.resume,
        skill_name=args.skill_name,
    )


# --- aggregate --------------------------------------------------------------


def cmd_aggregate(args: argparse.Namespace) -> dict:
    iteration_dir = Path(args.iteration_dir).resolve()
    benchmark = aggregate_benchmark.generate_benchmark(
        iteration_dir,
        skill_name=args.skill_name or "",
        skill_path=args.skill_path or "",
    )
    bench_json = iteration_dir / "benchmark.json"
    bench_md = iteration_dir / "benchmark.md"
    bench_json.write_text(json.dumps(benchmark, indent=2))
    bench_md.write_text(aggregate_benchmark.generate_markdown(benchmark))
    return {
        "status": "ok",
        "benchmark_json": str(bench_json),
        "benchmark_md": str(bench_md),
        "variants": benchmark["metadata"].get("variants", []),
        "primary_variant": benchmark["metadata"].get("primary_variant"),
        "baseline_variant": benchmark["metadata"].get("baseline_variant"),
    }


# --- iterate ----------------------------------------------------------------


def cmd_iterate(args: argparse.Namespace) -> dict:
    return iterate.run_iteration(args)


# --- view -------------------------------------------------------------------


def cmd_view(args: argparse.Namespace) -> dict:
    iteration_dir = Path(args.iteration_dir).resolve()
    benchmark_path = iteration_dir / "benchmark.json"
    if not benchmark_path.exists():
        raise SystemExit(
            f"benchmark.json missing at {benchmark_path}; run `better-skills aggregate {iteration_dir}` first"
        )
    skill_name = args.skill_name
    if not skill_name:
        manifest = aggregate_benchmark.load_manifest(iteration_dir)
        skill_name = manifest.get("skill_name") or iteration_dir.parent.name
    prev_dir = None
    if args.previous_iteration is not None:
        prev_dir = iteration_dir.parent / f"iteration-{args.previous_iteration}"
    viewer_log = iteration_dir / "viewer.log"
    pid = iterate.launch_viewer(
        iteration_dir=iteration_dir,
        skill_name=skill_name,
        benchmark_path=benchmark_path,
        previous_iteration_dir=prev_dir,
        viewer_log=viewer_log,
    )
    return {"status": "ok", "viewer_pid": pid, "viewer_log": str(viewer_log)}


# --- trigger pipeline -------------------------------------------------------


def cmd_trigger_eval(args: argparse.Namespace) -> dict:
    return run_eval.run_from_cli(args)


def cmd_trigger_improve(args: argparse.Namespace) -> dict:
    return improve_description.run_from_cli(args)


def cmd_trigger_loop(args: argparse.Namespace) -> dict:
    return run_loop.run_from_cli(args)


# --- main -------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="better-skills",
        description="Single CLI for the Agent Skills evaluation pipelines.",
    )
    sub = p.add_subparsers(dest="command", required=True, metavar="<command>")

    # init
    sp = sub.add_parser("init", help="Scaffold evals.json + triggers.json templates.")
    sp.add_argument("skill_path")
    sp.add_argument("--force", action="store_true", help="Overwrite existing files.")
    sp.set_defaults(handler=cmd_init)

    # snapshot
    sp = sub.add_parser("snapshot", help="Snapshot the skill into <workspace>/skill-snapshot/.")
    sp.add_argument("skill_path")
    sp.add_argument("--workspace", required=True)
    sp.add_argument("--snapshot-path", default=None)
    sp.add_argument("--force", action="store_true", help="Overwrite existing snapshot.")
    sp.set_defaults(handler=cmd_snapshot)

    # run / iterate share the executor flag set
    def _add_run_args(p: argparse.ArgumentParser) -> None:
        p.add_argument("--skill-path", required=True)
        p.add_argument("--workspace", required=True)
        p.add_argument("--iteration", type=int, required=True)
        p.add_argument("--evals-json", default=None)
        p.add_argument("--snapshot-path", default=None)
        p.add_argument("--num-workers", type=int, default=None)
        p.add_argument("--default-timeout", type=int, default=None)
        p.add_argument("--runs-per-config", type=int, default=None)
        p.add_argument("--phase", choices=["all", "executor", "grader"], default="all")
        p.add_argument("--grader-md", default=None)
        p.add_argument("--resume", action="store_true")
        p.add_argument("--skill-name", default=None)

    # run
    sp = sub.add_parser("run", help="Run executors + graders for one iteration.")
    _add_run_args(sp)
    sp.set_defaults(handler=cmd_run)

    # aggregate
    sp = sub.add_parser("aggregate", help="Aggregate per-run grading into benchmark.json + .md.")
    sp.add_argument("iteration_dir")
    sp.add_argument("--skill-name", default=None)
    sp.add_argument("--skill-path", default=None)
    sp.set_defaults(handler=cmd_aggregate)

    # iterate
    sp = sub.add_parser("iterate", help="Full pipeline: run + aggregate + upload + view.")
    _add_run_args(sp)
    sp.add_argument("--no-view", action="store_true")
    sp.add_argument("--no-aggregate", action="store_true")
    sp.add_argument("--previous-iteration", type=int, default=None)
    sp.set_defaults(handler=cmd_iterate)

    # view
    sp = sub.add_parser("view", help="Launch the eval-viewer in the background.")
    sp.add_argument("iteration_dir")
    sp.add_argument("--skill-name", default=None)
    sp.add_argument("--previous-iteration", type=int, default=None)
    sp.set_defaults(handler=cmd_view)

    # trigger-eval
    sp = sub.add_parser("trigger-eval", help="Run trigger queries against a description.")
    sp.add_argument("--skill-path", required=True)
    sp.add_argument("--triggers-json", default=None,
                    help="Default: <skill>/triggers.json.")
    sp.add_argument("--description", default=None)
    sp.add_argument("--num-workers", type=int, default=None)
    sp.add_argument("--timeout", type=int, default=None)
    sp.add_argument("--runs-per-query", type=int, default=None)
    sp.add_argument("--trigger-threshold", type=float, default=None)
    sp.add_argument("--model", default=None)
    sp.add_argument("--verbose", action="store_true")
    sp.set_defaults(handler=cmd_trigger_eval)

    # trigger-improve
    sp = sub.add_parser("trigger-improve", help="Propose improved description from prior eval results.")
    sp.add_argument("--skill-path", required=True)
    sp.add_argument("--eval-results", required=True)
    sp.add_argument("--history", default=None)
    sp.add_argument("--model", default=None)
    sp.add_argument("--verbose", action="store_true")
    sp.set_defaults(handler=cmd_trigger_improve)

    # trigger-loop
    sp = sub.add_parser("trigger-loop", help="Iterative eval+improve loop with train/test split.")
    sp.add_argument("--skill-path", required=True)
    sp.add_argument("--triggers-json", default=None)
    sp.add_argument("--description", default=None)
    sp.add_argument("--num-workers", type=int, default=None)
    sp.add_argument("--timeout", type=int, default=None)
    sp.add_argument("--max-iterations", type=int, default=None)
    sp.add_argument("--runs-per-query", type=int, default=None)
    sp.add_argument("--trigger-threshold", type=float, default=None)
    sp.add_argument("--holdout", type=float, default=None)
    sp.add_argument("--model", default=None)
    sp.add_argument("--verbose", action="store_true")
    sp.add_argument("--report", default="auto")
    sp.add_argument("--results-dir", default=None)
    sp.set_defaults(handler=cmd_trigger_loop)

    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        result = args.handler(args)
    except ConfigError as e:
        print(f"[config] {e}", file=sys.stderr)
        sys.exit(2)
    except FileNotFoundError as e:
        print(f"[error] {e}", file=sys.stderr)
        sys.exit(2)
    if result is not None:
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
