#!/usr/bin/env python3
"""Run functional evals for a skill via `claude -p` subprocess.

Reads variants and cases from evals.json (see scripts/config.py for the schema).
For each (case × variant), spawns a `claude -p` executor in parallel. After
all executors complete, spawns a grader subprocess per run that evaluates
expectations against the transcript + outputs.

Variants are data: each variant declares a `mount` (self/none/snapshot/path)
that decides what skill, if any, is attached for that comparison branch. There
are no hardcoded "with_skill"/"without_skill" strings in this script.

Same spawn semantics as before — stream-json + verbose, bypassPermissions,
env inherits everything except CLAUDECODE so `claude -p` can nest inside a
Claude Code session.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

try:
    from .config import EvalsConfig, VariantConfig, load_evals_config
except ImportError:
    from config import EvalsConfig, VariantConfig, load_evals_config  # type: ignore


DEFAULT_TIMEOUT = 600
DEFAULT_WORKERS = 4

MANIFEST_FILE = "manifest.json"
RUN_STATUS_FILE = "run_status.json"
MANIFEST_VERSION = 1

# Status progression for a single run. Each step subsumes the prior one — a
# "graded" run has also been "executed". `--resume` uses these as ordered
# checkpoints to skip already-completed work.
STATUS_PENDING = "pending"
STATUS_EXECUTED = "executed"
STATUS_GRADED = "graded"
STATUS_FAILED = "failed"


def _env() -> dict:
    # Drop CLAUDECODE so `claude -p` can nest inside a Claude Code session.
    # Same pattern as run_eval.py.
    return {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _run_id(eval_id: int, config: str, replicate: int) -> str:
    return f"eval-{eval_id}-{config}-run-{replicate}"


def _ensure_snapshot(skill_path: Path, snapshot_path: Path) -> None:
    """For old_skill baseline: copy current skill into snapshot dir if absent.

    The snapshot is meant to capture "the version we're comparing against" — usually
    the previous iteration's skill. We never overwrite an existing snapshot because
    the user may have already iterated past it; refreshing the baseline is an
    explicit `rm -rf <snapshot>` operation, not a side effect of running evals.
    """
    if snapshot_path.exists():
        return
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(skill_path, snapshot_path)
    print(
        f"[snapshot] created baseline snapshot at {snapshot_path} (from {skill_path}). "
        f"Delete this dir to reset the baseline.",
        file=sys.stderr,
        flush=True,
    )


def _write_run_status(run_dir: Path, status: str, **fields) -> None:
    """Write run_status.json atomically. Read by --resume and manifest rebuild."""
    run_dir.mkdir(parents=True, exist_ok=True)
    path = run_dir / RUN_STATUS_FILE
    existing = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            existing = {}
    existing.update({"status": status, "updated_at": _now_iso(), **fields})
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(existing, indent=2))
    tmp.replace(path)


def _read_run_status(run_dir: Path) -> dict | None:
    path = run_dir / RUN_STATUS_FILE
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _is_at_least(current: str | None, target: str) -> bool:
    """Status ordering: pending < executed < graded. failed never satisfies."""
    order = {STATUS_PENDING: 0, STATUS_EXECUTED: 1, STATUS_GRADED: 2}
    if current is None or current == STATUS_FAILED:
        return False
    return order.get(current, -1) >= order.get(target, 99)


def _read_grading_summary(run_dir: Path) -> dict | None:
    path = run_dir / "grading.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text()).get("summary") or {}
    except (json.JSONDecodeError, OSError):
        return None


def _executor_completed(run_dir: Path) -> bool:
    """True when the executor produced a usable transcript with a final result event.

    Resume uses this rather than run_status.status so a grader failure never
    forces a full executor re-run — the executor's success is verifiable from
    its transcript, independent of the grader's later fate.
    """
    transcript = run_dir / "transcript.jsonl"
    if not transcript.exists() or transcript.stat().st_size == 0:
        return False
    try:
        with open(transcript) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    if json.loads(line).get("type") == "result":
                        return True
                except json.JSONDecodeError:
                    continue
    except OSError:
        return False
    return False


def _grader_completed(run_dir: Path) -> bool:
    """True when grading.json exists and parses — grader's success is its output."""
    path = run_dir / "grading.json"
    if not path.exists():
        return False
    try:
        json.loads(path.read_text())
        return True
    except (json.JSONDecodeError, OSError):
        return False


def _read_timing(run_dir: Path) -> dict | None:
    path = run_dir / "timing.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _build_manifest_skeleton(
    *,
    iteration: int,
    skill_name: str,
    skill_path: Path,
    snapshot_path: Path | None,
    primary_variant: str,
    baseline_variant: str | None,
    evals_json: Path,
    model: str | None,
    runs: list[dict],
    iteration_dir: Path,
) -> dict:
    """Construct the initial manifest with all planned runs marked pending.

    `primary_variant` and `baseline_variant` come from the evals.json defaults
    block; downstream consumers (aggregate_benchmark, dashboard) read them
    instead of guessing from a hardcoded preference list.
    """
    # Preserve the order in which variants first appear so iteration is stable.
    configs: list[str] = []
    for r in runs:
        if r["variant"] not in configs:
            configs.append(r["variant"])
    return {
        "version": MANIFEST_VERSION,
        "iteration": iteration,
        "skill_name": skill_name,
        "skill_path": str(skill_path),
        "snapshot_path": str(snapshot_path) if snapshot_path else None,
        "primary_variant": primary_variant,
        "baseline_variant": baseline_variant,
        "evals_json_path": str(evals_json),
        "model": model,
        "configs": configs,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "runs": [
            {
                "id": _run_id(r["eval_id"], r["variant"], r["run_number"]),
                "eval_id": r["eval_id"],
                "eval_name": r["eval_name"],
                "config": r["variant"],
                "replicate": r["run_number"],
                "path": str(r["run_dir"].relative_to(iteration_dir)),
                "status": STATUS_PENDING,
            }
            for r in runs
        ],
    }


def _refresh_manifest_runs(iteration_dir: Path, manifest: dict) -> dict:
    """Walk per-run status files + grading.json and update the manifest in place.

    Source of truth is on disk — this rebuild is idempotent and tolerates partial
    or crashed runs. Any field already on the run entry is preserved unless we
    have a fresher value from disk.
    """
    for entry in manifest.get("runs", []):
        run_dir = iteration_dir / entry["path"]
        status_data = _read_run_status(run_dir) or {}
        if status_data.get("status"):
            entry["status"] = status_data["status"]
        # Surface failure detail fields so the manifest alone tells you why a run
        # is marked failed — no need to crawl into the run dir.
        for fail_field in (
            "executor_exit_code", "executor_timed_out",
            "grader_exit_code", "grader_timed_out",
        ):
            if fail_field in status_data:
                entry[fail_field] = status_data[fail_field]
        timing = _read_timing(run_dir) or {}
        if "executor_duration_seconds" in timing:
            entry["executor_duration_s"] = round(timing["executor_duration_seconds"], 3)
        if "grader_duration_seconds" in timing:
            entry["grader_duration_s"] = round(timing["grader_duration_seconds"], 3)
        if "total_tokens" in timing:
            entry["tokens"] = timing["total_tokens"]
        gsum = _read_grading_summary(run_dir)
        if gsum is not None:
            entry["pass_rate"] = gsum.get("pass_rate")
            entry["expectations_passed"] = gsum.get("passed")
            entry["expectations_total"] = gsum.get("total")
    manifest["updated_at"] = _now_iso()
    return manifest


def _write_manifest(iteration_dir: Path, manifest: dict) -> Path:
    iteration_dir.mkdir(parents=True, exist_ok=True)
    path = iteration_dir / MANIFEST_FILE
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2))
    tmp.replace(path)
    return path


def run_claude_p(
    prompt: str,
    cwd: Path,
    transcript_path: Path,
    stderr_path: Path,
    timeout: int,
    model: str | None = None,
    append_system_prompt: str | None = None,
) -> tuple[int, bool]:
    """Spawn a claude -p subprocess. Returns (exit_code, timed_out)."""
    cmd = [
        "claude", "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "bypassPermissions",
    ]
    if model:
        cmd.extend(["--model", model])
    if append_system_prompt:
        cmd.extend(["--append-system-prompt", append_system_prompt])

    cwd.mkdir(parents=True, exist_ok=True)
    with open(transcript_path, "w") as tfile, open(stderr_path, "w") as efile:
        try:
            result = subprocess.run(
                cmd,
                input=prompt,
                stdout=tfile,
                stderr=efile,
                text=True,
                cwd=str(cwd),
                env=_env(),
                timeout=timeout,
            )
            return result.returncode, False
        except subprocess.TimeoutExpired:
            return -1, True


def parse_result_event(transcript_path: Path) -> dict:
    """Return the final `result` event's timing/tokens, defensive on crashes."""
    last_result = None
    try:
        with open(transcript_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if ev.get("type") == "result":
                    last_result = ev
    except FileNotFoundError:
        pass

    if not last_result:
        return {"total_tokens": 0, "duration_ms": 0, "total_duration_seconds": 0.0}

    usage = last_result.get("usage") or {}
    total_tokens = (usage.get("input_tokens") or 0) + (usage.get("output_tokens") or 0)
    duration_ms = last_result.get("duration_ms") or 0
    return {
        "total_tokens": total_tokens,
        "duration_ms": duration_ms,
        "total_duration_seconds": duration_ms / 1000.0,
    }


def build_executor_envelope(
    skill_path: Path | None,
    prompt: str,
    files: list[str],
) -> str:
    """Construct the executor prompt: skill hint + outputs hint + input files + user prompt."""
    lines = []
    if skill_path:
        lines.append(f"Use the skill at {skill_path}. Save any outputs to ./outputs/.")
    else:
        lines.append("Save any outputs to ./outputs/.")
    if files:
        lines.append(f"Input files: {', '.join(files)}")
    lines.append("")
    lines.append(prompt)
    return "\n".join(lines)


def run_executor(
    run_dir: Path,
    skill_path: Path | None,
    prompt: str,
    files: list[str],
    timeout: int,
    model: str | None,
) -> dict:
    """Run one executor subprocess; write timing.json; return result dict."""
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "outputs").mkdir(exist_ok=True)
    transcript = run_dir / "transcript.jsonl"
    stderr = run_dir / "stderr.log"

    envelope = build_executor_envelope(skill_path, prompt, files)

    start_iso, start_wall = _now_iso(), time.time()
    exit_code, timed_out = run_claude_p(
        prompt=envelope,
        cwd=run_dir,
        transcript_path=transcript,
        stderr_path=stderr,
        timeout=timeout,
        model=model,
    )
    end_wall, end_iso = time.time(), _now_iso()

    parsed = parse_result_event(transcript)
    timing = {
        **parsed,
        "executor_start": start_iso,
        "executor_end": end_iso,
        "executor_duration_seconds": end_wall - start_wall,
    }
    (run_dir / "timing.json").write_text(json.dumps(timing, indent=2))

    if exit_code == 0 and not timed_out:
        _write_run_status(run_dir, STATUS_EXECUTED, executor_completed_at=end_iso)
    else:
        _write_run_status(
            run_dir,
            STATUS_FAILED,
            executor_completed_at=end_iso,
            executor_exit_code=exit_code,
            executor_timed_out=timed_out,
        )

    return {
        "exit_code": exit_code,
        "timed_out": timed_out,
        "timing": timing,
    }


def run_grader(
    run_dir: Path,
    expectations: list[str],
    grader_system_prompt: str,
    timeout: int,
    model: str | None,
) -> dict:
    """Run one grader subprocess; update timing.json + grading.json with grader timings."""
    transcript = (run_dir / "transcript.jsonl").resolve()
    outputs_dir = (run_dir / "outputs").resolve()
    grading_path = (run_dir / "grading.json").resolve()
    grader_transcript = run_dir / "grader_transcript.jsonl"
    grader_stderr = run_dir / "grader_stderr.log"

    expectations_block = (
        "\n".join(f"- {e}" for e in expectations) if expectations else "(none)"
    )
    prompt = (
        "Grade this run against the expectations below.\n"
        "\n"
        f"Expectations:\n{expectations_block}\n"
        "\n"
        f"transcript_path: {transcript}\n"
        f"outputs_dir: {outputs_dir}\n"
        "\n"
        f"Write grading.json to: {grading_path}\n"
        "Follow your system-prompt instructions.\n"
    )

    start_iso, start_wall = _now_iso(), time.time()
    exit_code, timed_out = run_claude_p(
        prompt=prompt,
        cwd=run_dir,
        transcript_path=grader_transcript,
        stderr_path=grader_stderr,
        timeout=timeout,
        model=model,
        append_system_prompt=grader_system_prompt,
    )
    end_wall, end_iso = time.time(), _now_iso()
    grader_duration = end_wall - start_wall

    # Append grader timings to timing.json
    timing_path = run_dir / "timing.json"
    timing = json.loads(timing_path.read_text()) if timing_path.exists() else {}
    timing["grader_start"] = start_iso
    timing["grader_end"] = end_iso
    timing["grader_duration_seconds"] = grader_duration
    timing_path.write_text(json.dumps(timing, indent=2))

    # Backfill grader_duration_seconds into grading.json (grader can't know its own duration).
    # Also pin total_duration_seconds to executor wall-clock: downstream aggregate_benchmark
    # reads this as the benchmark's "time_seconds" metric, which should mean "how long the
    # skill took to run" — not "executor + grader overhead". Grader time is captured
    # separately in grader_duration_seconds for diagnostics.
    grading_summary = None
    if grading_path.exists():
        try:
            grading = json.loads(grading_path.read_text())
            t = grading.setdefault("timing", {})
            t["grader_duration_seconds"] = grader_duration
            if "executor_duration_seconds" in t:
                t["total_duration_seconds"] = t["executor_duration_seconds"]
            grading_path.write_text(json.dumps(grading, indent=2))
            grading_summary = grading.get("summary")
        except (json.JSONDecodeError, OSError):
            pass

    if exit_code == 0 and not timed_out and grading_path.exists():
        _write_run_status(run_dir, STATUS_GRADED, grader_completed_at=end_iso)
    else:
        _write_run_status(
            run_dir,
            STATUS_FAILED,
            grader_completed_at=end_iso,
            grader_exit_code=exit_code,
            grader_timed_out=timed_out,
        )

    return {
        "exit_code": exit_code,
        "timed_out": timed_out,
        "grading_exists": grading_path.exists(),
        "grading_summary": grading_summary,
    }


def _resolve_mount(
    variant: VariantConfig,
    skill_path: Path,
    snapshot_path: Path | None,
) -> Path | None:
    """Resolve a variant's mount declaration into an actual on-disk skill path
    (or None for mount=none)."""
    if variant.mount == "self":
        return skill_path
    if variant.mount == "none":
        return None
    if variant.mount == "snapshot":
        if snapshot_path is None:
            raise RuntimeError(
                f"variant '{variant.name}' uses mount=snapshot but no snapshot_path was "
                f"provided. Pass --snapshot-path or rely on the workspace default."
            )
        return snapshot_path
    if variant.mount == "path":
        assert variant.path
        return Path(variant.path).expanduser().resolve()
    raise ValueError(f"unknown mount type: {variant.mount}")


def plan_runs(
    config: EvalsConfig,
    workspace: Path,
    iteration: int,
    skill_path: Path,
    snapshot_path: Path | None,
    default_timeout: int,
    runs_per_config: int,
) -> list[dict]:
    """Expand cases × variants into per-run specs. Writes eval_metadata.json into each eval dir.

    Directory layout:
      iteration-N/eval-<id>/<variant-name>/run-<k>/{transcript.jsonl, timing.json, grading.json, outputs/}

    Variant names come from the config (no hardcoded with_skill/without_skill); the
    aggregator discovers them via manifest.configs.
    """
    iteration_dir = workspace / f"iteration-{iteration}"
    runs: list[dict] = []
    for case in config.cases:
        eval_dir = iteration_dir / f"eval-{case.id}"
        eval_dir.mkdir(parents=True, exist_ok=True)

        prompt = config.resolve_prompt(case, skill_path)
        eval_name = case.name or f"eval-{case.id}"
        expectations = list(case.expectations)

        metadata = {
            "eval_id": case.id,
            "eval_name": eval_name,
            "prompt": prompt,
            "assertions": expectations,
        }
        (eval_dir / "eval_metadata.json").write_text(json.dumps(metadata, indent=2))

        common = {
            "eval_id": case.id,
            "eval_name": eval_name,
            "prompt": prompt,
            "files": list(case.files),
            "expectations": expectations,
            "timeout": case.timeout_s or default_timeout,
        }

        for k in range(1, runs_per_config + 1):
            for variant in config.variants:
                runs.append({
                    **common,
                    "variant": variant.name,
                    "run_number": k,
                    "run_dir": eval_dir / variant.name / f"run-{k}",
                    "skill_path": _resolve_mount(variant, skill_path, snapshot_path),
                })

    return runs


def run_phase_executor(
    runs: list[dict],
    num_workers: int,
    model: str | None,
    resume: bool = False,
) -> list[dict]:
    """Run executor for all `runs`. With resume=True, skip runs whose transcript
    already contains a final result event — that's an externally-verifiable signal
    of executor success, independent of any later grader failure."""
    results = []
    todo = []
    skipped = 0
    for r in runs:
        if resume and _executor_completed(r["run_dir"]):
            # Already done — synthesise a successful result so the grader phase
            # can proceed without re-running the executor. We pull timing from
            # disk so resumed runs still have accurate metrics.
            results.append({
                **r,
                "exit_code": 0,
                "timed_out": False,
                "timing": _read_timing(r["run_dir"]) or {},
                "resumed": True,
            })
            skipped += 1
            continue
        todo.append(r)
    if skipped:
        print(f"[resume] skipping {skipped}/{len(runs)} executor runs already complete",
              file=sys.stderr, flush=True)

    with ThreadPoolExecutor(max_workers=num_workers) as pool:
        futures = {
            pool.submit(
                run_executor,
                r["run_dir"],
                r["skill_path"],
                r["prompt"],
                r["files"],
                r["timeout"],
                model,
            ): r for r in todo
        }
        done = 0
        for future in as_completed(futures):
            r = futures[future]
            try:
                out = future.result()
            except Exception as e:
                out = {"exit_code": -1, "timed_out": False, "error": str(e), "timing": {}}
            done += 1
            timing = out.get("timing") or {}
            status = "OK" if out.get("exit_code") == 0 else f"FAIL exit={out.get('exit_code')}"
            print(
                f"[exec {done}/{len(todo)}] eval-{r['eval_id']}/{r['variant']}/run-{r['run_number']} {status} "
                f"tokens={timing.get('total_tokens', 0)} "
                f"dur={timing.get('total_duration_seconds', 0):.1f}s",
                file=sys.stderr,
                flush=True,
            )
            results.append({**r, **out})
    return results


def run_phase_grader(
    executor_results: list[dict],
    grader_system_prompt: str,
    num_workers: int,
    timeout: int,
    model: str | None,
    resume: bool = False,
) -> list[dict]:
    """Run grader for each executor result. Only grades runs whose executor produced
    a usable transcript (failed executors are skipped — there's nothing to grade).
    With resume=True, additionally skip runs that already have a parseable grading.json.
    """
    results = []
    todo = []
    skipped_no_transcript = 0
    skipped_resume = 0
    for r in executor_results:
        if not _executor_completed(r["run_dir"]):
            # Executor failed or never ran — grading would crash on missing transcript.
            results.append({
                "eval_id": r["eval_id"],
                "eval_name": r["eval_name"],
                "variant": r["variant"],
                "run_number": r["run_number"],
                "run_dir": str(r["run_dir"]),
                "exit_code": -1,
                "timed_out": False,
                "grading_exists": False,
                "grading_summary": None,
                "skipped_reason": "no_transcript",
            })
            skipped_no_transcript += 1
            continue
        if resume and _grader_completed(r["run_dir"]):
            gsum = _read_grading_summary(r["run_dir"]) or {}
            results.append({
                "eval_id": r["eval_id"],
                "eval_name": r["eval_name"],
                "variant": r["variant"],
                "run_number": r["run_number"],
                "run_dir": str(r["run_dir"]),
                "exit_code": 0,
                "timed_out": False,
                "grading_exists": True,
                "grading_summary": gsum,
                "resumed": True,
            })
            skipped_resume += 1
            continue
        todo.append(r)
    if skipped_no_transcript:
        print(f"[grade] skipping {skipped_no_transcript} runs without a transcript "
              f"(executor never produced one)", file=sys.stderr, flush=True)
    if skipped_resume:
        print(f"[resume] skipping {skipped_resume}/{len(executor_results)} grader runs already complete",
              file=sys.stderr, flush=True)

    with ThreadPoolExecutor(max_workers=num_workers) as pool:
        futures = {
            pool.submit(
                run_grader,
                r["run_dir"],
                r["expectations"],
                grader_system_prompt,
                timeout,
                model,
            ): r for r in todo
        }
        done = 0
        for future in as_completed(futures):
            r = futures[future]
            try:
                out = future.result()
            except Exception as e:
                out = {"exit_code": -1, "timed_out": False, "error": str(e), "grading_exists": False, "grading_summary": None}
            done += 1
            gsum = out.get("grading_summary") or {}
            status = "OK" if out.get("exit_code") == 0 else f"FAIL exit={out.get('exit_code')}"
            print(
                f"[grade {done}/{len(todo)}] eval-{r['eval_id']}/{r['variant']}/run-{r['run_number']} {status} "
                f"graded={gsum.get('passed', '?')}/{gsum.get('total', '?')}",
                file=sys.stderr,
                flush=True,
            )
            results.append({
                "eval_id": r["eval_id"],
                "eval_name": r["eval_name"],
                "variant": r["variant"],
                "run_number": r["run_number"],
                "run_dir": str(r["run_dir"]),
                **out,
            })
    return results


def _serialize_executor_result(r: dict) -> dict:
    return {
        "eval_id": r["eval_id"],
        "eval_name": r["eval_name"],
        "variant": r["variant"],
        "run_number": r["run_number"],
        "run_dir": str(r["run_dir"]),
        "skill_path": str(r["skill_path"]) if r["skill_path"] else None,
        "exit_code": r.get("exit_code"),
        "timed_out": r.get("timed_out"),
        "timing": r.get("timing"),
    }


def run_all(
    *,
    evals_json: Path,
    skill_path: Path,
    workspace: Path,
    iteration: int,
    snapshot_path: Path | None = None,
    num_workers: int | None = None,
    default_timeout: int | None = None,
    runs_per_config: int | None = None,
    model: str | None = None,
    phase: str = "all",
    grader_md: Path | None = None,
    resume: bool = False,
    skill_name: str | None = None,
) -> dict:
    """Library entry point: load config + plan + (optionally) snapshot + execute + grade + write manifest.

    `evals_json` is the new-format config (see scripts/config.py). Variants and
    defaults come from there; CLI arguments override the config defaults when
    provided. Used directly by the `skill-eval` CLI dispatcher.
    """
    evals_json = Path(evals_json).resolve()
    skill_path = Path(skill_path).resolve()
    workspace = Path(workspace).resolve()

    config = load_evals_config(evals_json)

    # CLI overrides win over config defaults.
    num_workers = num_workers if num_workers is not None else config.defaults.num_workers
    default_timeout = default_timeout if default_timeout is not None else config.defaults.timeout_s
    runs_per_config = runs_per_config if runs_per_config is not None else config.defaults.runs_per_variant
    skill_name = skill_name or config.skill_name or skill_path.name
    model = model or config.default_model

    # Auto-snapshot whenever any variant uses mount=snapshot. Workspace default
    # is <workspace>/skill-snapshot/. Existing snapshots are never overwritten.
    needs_snapshot = any(v.mount == "snapshot" for v in config.variants)
    if needs_snapshot:
        if snapshot_path is None:
            snapshot_path = workspace / "skill-snapshot"
        snapshot_path = Path(snapshot_path).resolve()
        _ensure_snapshot(skill_path, snapshot_path)
    elif snapshot_path is not None:
        snapshot_path = Path(snapshot_path).resolve()

    runs = plan_runs(
        config=config,
        workspace=workspace,
        iteration=iteration,
        skill_path=skill_path,
        snapshot_path=snapshot_path,
        default_timeout=default_timeout,
        runs_per_config=runs_per_config,
    )

    iteration_dir = workspace / f"iteration-{iteration}"
    manifest = _build_manifest_skeleton(
        iteration=iteration,
        skill_name=skill_name,
        skill_path=skill_path,
        snapshot_path=snapshot_path,
        primary_variant=config.defaults.primary_variant,
        baseline_variant=config.defaults.baseline_variant,
        evals_json=evals_json,
        model=model,
        runs=runs,
        iteration_dir=iteration_dir,
    )
    # Always fold existing on-disk state into the skeleton — even on a non-resume
    # re-run, the prior iteration's run dirs may have artifacts that the user can
    # see in their viewer until our own runs overwrite them. Writing all-pending
    # would lie about the visible state. Refresh is idempotent.
    _refresh_manifest_runs(iteration_dir, manifest)
    manifest_path = _write_manifest(iteration_dir, manifest)

    print(
        f"[plan] {len(config.cases)} cases × {len(config.variants)} variants = "
        f"{len(runs)} executor runs, phase={phase}, resume={resume}",
        file=sys.stderr,
        flush=True,
    )

    executor_results: list[dict] = []
    if phase in ("all", "executor"):
        executor_results = run_phase_executor(runs, num_workers, model, resume=resume)
        # Refresh + rewrite manifest between phases so a viewer reading the file
        # sees real status before grading even starts.
        _refresh_manifest_runs(iteration_dir, manifest)
        _write_manifest(iteration_dir, manifest)
    else:
        # grader-only: only consider runs whose executor actually produced a
        # transcript. Synthesising success for runs without transcripts would
        # send the grader off to read non-existent files.
        executor_results = []
        skipped = 0
        for r in runs:
            if _executor_completed(r["run_dir"]):
                executor_results.append({**r, "exit_code": 0, "timed_out": False, "timing": _read_timing(r["run_dir"]) or {}})
            else:
                skipped += 1
        if skipped:
            print(f"[plan] grader-only: skipping {skipped} runs without a transcript "
                  f"(executor never completed)", file=sys.stderr, flush=True)

    grader_results: list[dict] | None = None
    if phase in ("all", "grader"):
        grader_md_path = Path(grader_md) if grader_md else (
            Path(__file__).resolve().parent.parent / "agents" / "grader.md"
        )
        if not grader_md_path.exists():
            raise FileNotFoundError(f"grader.md not found at {grader_md_path}")
        grader_system_prompt = grader_md_path.read_text()
        grader_results = run_phase_grader(
            executor_results=executor_results,
            grader_system_prompt=grader_system_prompt,
            num_workers=num_workers,
            timeout=default_timeout,
            model=model,
            resume=resume,
        )

    # Final manifest refresh: pulls in everything just written to disk.
    _refresh_manifest_runs(iteration_dir, manifest)
    _write_manifest(iteration_dir, manifest)

    return {
        "iteration": iteration,
        "workspace": str(workspace),
        "iteration_dir": str(iteration_dir),
        "manifest_path": str(manifest_path),
        "skill_path": str(skill_path),
        "snapshot_path": str(snapshot_path) if snapshot_path else None,
        "primary_variant": config.defaults.primary_variant,
        "baseline_variant": config.defaults.baseline_variant,
        "variants": [v.name for v in config.variants],
        "phase": phase,
        "num_evals": len(config.cases),
        "num_runs": len(runs),
        "executors": [_serialize_executor_result(r) for r in executor_results],
        "graders": grader_results,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Run functional evals via claude -p. Variants come from evals.json.",
    )
    parser.add_argument("--evals-json", required=True, help="Path to evals.json (new schema; see scripts/config.py)")
    parser.add_argument("--skill-path", required=True, help="Path to the skill being iterated on (mount=self target)")
    parser.add_argument("--workspace", required=True, help="Workspace directory; iteration-N/ goes inside")
    parser.add_argument("--iteration", type=int, required=True)
    parser.add_argument("--snapshot-path", default=None,
                        help="Path to skill snapshot. Used by any variant with mount=snapshot. "
                             "Defaults to <workspace>/skill-snapshot/, auto-created from --skill-path if missing.")
    parser.add_argument("--num-workers", type=int, default=None,
                        help="Override evals.json defaults.num_workers")
    parser.add_argument("--default-timeout", type=int, default=None,
                        help="Override evals.json defaults.timeout_s")
    parser.add_argument("--runs-per-config", type=int, default=None,
                        help="Override evals.json defaults.runs_per_variant")
    parser.add_argument("--model", default=None,
                        help="Override evals.json default_model")
    parser.add_argument("--phase", choices=["all", "executor", "grader"], default="all",
                        help="'executor' only runs Step 1+3, 'grader' only runs Step 4 (expects existing transcripts).")
    parser.add_argument("--grader-md", default=None, help="Path to grader.md (default: <this-script>/../agents/grader.md)")
    parser.add_argument("--resume", action="store_true",
                        help="Skip runs whose transcript already shows executor success "
                             "(or grading.json exists, for the grader phase). Crash-safe.")
    parser.add_argument("--skill-name", default=None,
                        help="Override evals.json skill_name (which defaults to the skill directory name).")
    args = parser.parse_args()

    summary = run_all(
        evals_json=Path(args.evals_json),
        skill_path=Path(args.skill_path),
        workspace=Path(args.workspace),
        iteration=args.iteration,
        snapshot_path=Path(args.snapshot_path) if args.snapshot_path else None,
        num_workers=args.num_workers,
        default_timeout=args.default_timeout,
        runs_per_config=args.runs_per_config,
        model=args.model,
        phase=args.phase,
        grader_md=Path(args.grader_md) if args.grader_md else None,
        resume=args.resume,
        skill_name=args.skill_name,
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()


