#!/usr/bin/env python3
"""Aggregate per-run grading.json files into benchmark summary statistics.

Reads `<iteration-dir>/manifest.json` for skill metadata, baseline_resolved,
and replicate counts. Every iteration runs exactly two configs — `current`
and `baseline` — so aggregation is a fixed two-group operation.

delta = current - baseline.

Invoked via `better-skills aggregate <iteration-dir>`.
"""

import json
import math
from datetime import datetime, timezone
from pathlib import Path


MANIFEST_FILE = "manifest.json"
CONFIG_CURRENT = "current"
CONFIG_BASELINE = "baseline"


def load_manifest(iteration_dir: Path) -> dict:
    """Read iteration-N/manifest.json. Raises if missing or unreadable."""
    path = iteration_dir / MANIFEST_FILE
    if not path.exists():
        raise FileNotFoundError(
            f"manifest.json not found at {path}. Re-run "
            f"`better-skills run` to produce it."
        )
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        raise ValueError(f"manifest.json at {path} is unreadable: {e}") from e


def calculate_stats(values: list[float]) -> dict:
    """Calculate mean, stddev, min, max for a list of values."""
    if not values:
        return {"mean": 0.0, "stddev": 0.0, "min": 0.0, "max": 0.0}

    n = len(values)
    mean = sum(values) / n

    if n > 1:
        variance = sum((x - mean) ** 2 for x in values) / (n - 1)
        stddev = math.sqrt(variance)
    else:
        stddev = 0.0

    return {
        "mean": round(mean, 4),
        "stddev": round(stddev, 4),
        "min": round(min(values), 4),
        "max": round(max(values), 4),
    }


def load_run_results(benchmark_dir: Path) -> dict:
    """Load per-run grading.json files for the two fixed configs.

    Returns a dict {config_name: [run_result, ...]} where config_name is
    always one of "current" or "baseline".
    """
    if not list(benchmark_dir.glob("eval-*")):
        print(f"No eval directories found in {benchmark_dir}")
        return {}

    allowed_configs = {CONFIG_CURRENT, CONFIG_BASELINE}
    results: dict[str, list] = {CONFIG_CURRENT: [], CONFIG_BASELINE: []}

    for eval_idx, eval_dir in enumerate(sorted(benchmark_dir.glob("eval-*"))):
        metadata_path = eval_dir / "eval_metadata.json"
        if metadata_path.exists():
            try:
                eval_id = json.loads(metadata_path.read_text()).get("eval_id", eval_idx)
            except (json.JSONDecodeError, OSError):
                eval_id = eval_idx
        else:
            try:
                eval_id = int(eval_dir.name.split("-")[1])
            except ValueError:
                eval_id = eval_idx

        for config_dir in sorted(eval_dir.iterdir()):
            if not config_dir.is_dir() or config_dir.name not in allowed_configs:
                continue
            config = config_dir.name
            if not list(config_dir.glob("run-*")):
                continue

            for run_dir in sorted(config_dir.glob("run-*")):
                run_number = int(run_dir.name.split("-")[1])
                grading_file = run_dir / "grading.json"

                if not grading_file.exists():
                    print(f"Warning: grading.json not found in {run_dir}")
                    continue

                try:
                    grading = json.loads(grading_file.read_text())
                except json.JSONDecodeError as e:
                    print(f"Warning: Invalid JSON in {grading_file}: {e}")
                    continue

                summary = grading.get("summary") or {}
                result = {
                    "eval_id": eval_id,
                    "run_number": run_number,
                    "pass_rate": summary.get("pass_rate", 0.0),
                    "passed": summary.get("passed", 0),
                    "failed": summary.get("failed", 0),
                    "total": summary.get("total", 0),
                }

                # timing.json is the source of truth for total_tokens — grading.timing
                # only carries durations, not token counts.
                timing = grading.get("timing") or {}
                result["time_seconds"] = timing.get("total_duration_seconds", 0.0)
                result["tokens"] = 0
                timing_file = run_dir / "timing.json"
                if timing_file.exists():
                    try:
                        timing_data = json.loads(timing_file.read_text())
                        if not result["time_seconds"]:
                            result["time_seconds"] = timing_data.get("total_duration_seconds", 0.0)
                        result["tokens"] = timing_data.get("total_tokens", 0)
                    except json.JSONDecodeError:
                        pass

                metrics = grading.get("execution_metrics") or {}
                result["tool_calls"] = metrics.get("total_tool_calls", 0)
                result["errors"] = metrics.get("errors_encountered", 0)

                raw_expectations = grading.get("expectations") or []
                for exp in raw_expectations:
                    if "text" not in exp or "passed" not in exp:
                        print(f"Warning: expectation in {grading_file} missing required fields (text, passed, evidence): {exp}")
                result["expectations"] = raw_expectations

                notes_summary = grading.get("user_notes_summary") or {}
                notes = []
                notes.extend(notes_summary.get("uncertainties", []))
                notes.extend(notes_summary.get("needs_review", []))
                notes.extend(notes_summary.get("workarounds", []))
                result["notes"] = notes

                results[config].append(result)

    return results


def aggregate_results(results: dict) -> dict:
    """Aggregate run results into summary statistics for current and baseline.

    delta is always current - baseline (the natural reading of "did the
    current skill help"). Empty groups produce zeroed stats so the output
    shape is always the same.
    """
    run_summary: dict = {}

    for config in (CONFIG_CURRENT, CONFIG_BASELINE):
        runs = results.get(config) or []
        if not runs:
            run_summary[config] = {
                "pass_rate": {"mean": 0.0, "stddev": 0.0, "min": 0.0, "max": 0.0},
                "time_seconds": {"mean": 0.0, "stddev": 0.0, "min": 0.0, "max": 0.0},
                "tokens": {"mean": 0, "stddev": 0, "min": 0, "max": 0},
            }
            continue

        run_summary[config] = {
            "pass_rate": calculate_stats([r["pass_rate"] for r in runs]),
            "time_seconds": calculate_stats([r["time_seconds"] for r in runs]),
            "tokens": calculate_stats([r.get("tokens", 0) for r in runs]),
        }

    cur = run_summary[CONFIG_CURRENT]
    base = run_summary[CONFIG_BASELINE]
    run_summary["delta"] = {
        "pass_rate": f"{cur['pass_rate']['mean'] - base['pass_rate']['mean']:+.2f}",
        "time_seconds": f"{cur['time_seconds']['mean'] - base['time_seconds']['mean']:+.1f}",
        "tokens": f"{cur['tokens']['mean'] - base['tokens']['mean']:+.0f}",
    }
    return run_summary


def generate_benchmark(benchmark_dir: Path, skill_name: str = "", skill_path: str = "") -> dict:
    """Generate complete benchmark.json from run results.

    The two-group shape is fixed: "current" and "baseline" plus a "delta" entry.
    Manifest's `baseline_resolved` (e.g. "iteration-1", "none") is propagated
    into metadata so consumers know what was actually compared against.
    """
    manifest = load_manifest(benchmark_dir)
    skill_name = skill_name or manifest.get("skill_name") or ""
    skill_path = skill_path or manifest.get("skill_path") or ""

    results = load_run_results(benchmark_dir)
    run_summary = aggregate_results(results)

    runs = []
    for config in (CONFIG_CURRENT, CONFIG_BASELINE):
        for result in results.get(config, []):
            runs.append({
                "eval_id": result["eval_id"],
                "configuration": config,
                "run_number": result["run_number"],
                "result": {
                    "pass_rate": result["pass_rate"],
                    "passed": result["passed"],
                    "failed": result["failed"],
                    "total": result["total"],
                    "time_seconds": result["time_seconds"],
                    "tokens": result.get("tokens", 0),
                    "tool_calls": result.get("tool_calls", 0),
                    "errors": result.get("errors", 0),
                },
                "expectations": result["expectations"],
                "notes": result["notes"],
            })

    eval_ids = sorted(set(
        r["eval_id"]
        for config_results in results.values()
        for r in config_results
    ))

    replicates = [
        r.get("replicate", 0) for r in manifest.get("runs", [])
        if isinstance(r, dict)
    ]
    runs_per_config = max(replicates) if replicates else 0
    if not runs_per_config:
        all_run_numbers = [
            r["run_number"]
            for config_results in results.values()
            for r in config_results
        ]
        runs_per_config = max(all_run_numbers) if all_run_numbers else 0

    executor_model = manifest.get("model") or "<model-name>"

    benchmark = {
        "metadata": {
            "skill_name": skill_name or "<skill-name>",
            "skill_path": skill_path or "<path/to/skill>",
            "executor_model": executor_model,
            "analyzer_model": "<model-name>",
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "evals_run": eval_ids,
            "runs_per_configuration": runs_per_config,
            "baseline_spec": manifest.get("baseline_spec"),
            "baseline_resolved": manifest.get("baseline_resolved"),
        },
        "runs": runs,
        "run_summary": run_summary,
        "notes": [],
    }

    return benchmark


def generate_markdown(benchmark: dict) -> str:
    """Generate human-readable benchmark.md from benchmark data."""
    metadata = benchmark["metadata"]
    run_summary = benchmark["run_summary"]
    baseline_resolved = metadata.get("baseline_resolved") or "?"

    lines = [
        f"# Skill Benchmark: {metadata['skill_name']}",
        "",
        f"**Model**: {metadata['executor_model']}",
        f"**Date**: {metadata['timestamp']}",
        f"**Baseline**: {baseline_resolved}",
        f"**Evals**: {', '.join(map(str, metadata['evals_run']))} ({metadata['runs_per_configuration']} run{'s' if metadata['runs_per_configuration'] != 1 else ''} each per configuration)",
        "",
        "## Summary",
        "",
        "| Metric | Current | Baseline | Delta |",
        "|--------|---------|----------|-------|",
    ]

    cur = run_summary.get(CONFIG_CURRENT, {})
    base = run_summary.get(CONFIG_BASELINE, {})
    delta = run_summary.get("delta", {})

    cur_pr = cur.get("pass_rate", {})
    base_pr = base.get("pass_rate", {})
    lines.append(
        f"| Pass Rate | {cur_pr.get('mean', 0)*100:.0f}% ± {cur_pr.get('stddev', 0)*100:.0f}% | "
        f"{base_pr.get('mean', 0)*100:.0f}% ± {base_pr.get('stddev', 0)*100:.0f}% | "
        f"{delta.get('pass_rate', '—')} |"
    )

    cur_t = cur.get("time_seconds", {})
    base_t = base.get("time_seconds", {})
    lines.append(
        f"| Time | {cur_t.get('mean', 0):.1f}s ± {cur_t.get('stddev', 0):.1f}s | "
        f"{base_t.get('mean', 0):.1f}s ± {base_t.get('stddev', 0):.1f}s | "
        f"{delta.get('time_seconds', '—')}s |"
    )

    cur_tk = cur.get("tokens", {})
    base_tk = base.get("tokens", {})
    lines.append(
        f"| Tokens | {cur_tk.get('mean', 0):.0f} ± {cur_tk.get('stddev', 0):.0f} | "
        f"{base_tk.get('mean', 0):.0f} ± {base_tk.get('stddev', 0):.0f} | "
        f"{delta.get('tokens', '—')} |"
    )

    if benchmark.get("notes"):
        lines.extend(["", "## Notes", ""])
        for note in benchmark["notes"]:
            lines.append(f"- {note}")

    return "\n".join(lines)


