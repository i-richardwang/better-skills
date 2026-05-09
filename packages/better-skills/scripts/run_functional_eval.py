#!/usr/bin/env python3
"""Run functional evals for a skill via `claude -p` / `opencode run` subprocesses.

Reads cases from evals.json (see scripts/config.py for the schema). For each case,
runs two configurations — `current` (the live skill) and `baseline` (resolved from
`default_baseline` or `--baseline`). After all runs complete, the runner snapshots
the live skill into `iteration-N/skill-state/` so future iterations can compare
against it via `--baseline=previous` or `--baseline=iteration-N`.
"""

import hashlib
import json
import os
import queue
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from .config import EvalsConfig, load_evals_config, validate_baseline_spec
from .executor_opencode import (
    parse_opencode_final_event,
    run_opencode,
)


DEFAULT_TIMEOUT = 600
DEFAULT_WORKERS = 4

EXECUTOR_CLAUDE = "claude"
EXECUTOR_OPENCODE = "opencode"

# Fixed config names — used as directory names + dashboard column keys. The
# pre-rewrite codebase let users pick variant names via evals.json; this rewrite
# pins them to two stable values so downstream consumers (manifest, benchmark,
# dashboard) don't need to discover variant names dynamically.
CONFIG_CURRENT = "current"
CONFIG_BASELINE = "baseline"

MANIFEST_FILE = "manifest.json"
RUN_STATUS_FILE = "run_status.json"
MANIFEST_VERSION = 2

# Status progression for a single run. Each step subsumes the prior one — a
# "graded" run has also been "executed". `--resume` uses these as ordered
# checkpoints to skip already-completed work.
STATUS_PENDING = "pending"
STATUS_EXECUTED = "executed"
STATUS_GRADED = "graded"
STATUS_FAILED = "failed"

# Place each run's cwd outside any project tree so Claude Code's project-local
# discovery (cwd-upward `.claude/skills/`, project `CLAUDE.md`, `.claude/commands/`)
# cannot leak into the executor's system prompt and break the current/baseline
# comparison. Input files are staged into `iso_cwd/inputs/` and the executor
# writes outputs to `iso_cwd/outputs/`; the envelope references both by
# relative path so no project-tree path is named to the agent. Outputs are
# moved back into `run_dir/outputs/` after the executor exits.
ISO_CWD_ROOT = Path("/tmp/better-skills-iso")


def _isolated_cwd(run_dir: Path) -> Path:
    """Materialise an isolated cwd outside any project tree."""
    slug = "-".join(run_dir.parts[-4:])
    h = hashlib.sha1(str(run_dir.resolve()).encode()).hexdigest()[:8]
    iso = ISO_CWD_ROOT / f"{slug}-{h}"
    iso.mkdir(parents=True, exist_ok=True)
    return iso


def _stage_inputs(iso_cwd: Path, files: list[str]) -> list[str]:
    """Copy each input file into iso_cwd/inputs/<basename>; return relative paths.

    Errors on basename collision rather than silently overwriting — the envelope
    references files by basename, so collisions would silently shadow one file.
    """
    inputs_dir = iso_cwd / "inputs"
    if inputs_dir.exists():
        shutil.rmtree(inputs_dir)
    inputs_dir.mkdir(parents=True)

    seen: dict[str, str] = {}
    relative: list[str] = []
    for f in files:
        src = Path(f)
        name = src.name
        if name in seen:
            raise ValueError(
                f"input file basename collision: {name!r} appears as both "
                f"{seen[name]!r} and {f!r}. The envelope references inputs by "
                f"basename to keep the executor's cwd path-agnostic; rename one."
            )
        seen[name] = f
        dst = inputs_dir / name
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
        relative.append(f"inputs/{name}")
    return relative


def _collect_outputs(iso_outputs: Path, run_outputs: Path) -> None:
    """Move executor-written outputs from iso_cwd/outputs/ into run_dir/outputs/.

    Always called (try/finally), so partial outputs from a crashed/timed-out
    executor are still visible for debugging.
    """
    if not iso_outputs.exists():
        return
    run_outputs.mkdir(parents=True, exist_ok=True)
    for item in iso_outputs.iterdir():
        dst = run_outputs / item.name
        if dst.exists():
            if dst.is_dir():
                shutil.rmtree(dst)
            else:
                dst.unlink()
        shutil.move(str(item), str(dst))


def _resolve_case_file(file_ref: str, evals_json: Path) -> str:
    """Resolve case.files entries to absolute paths against evals.json's dir."""
    p = Path(file_ref)
    if p.is_absolute():
        return str(p)
    return str((evals_json.parent / p).resolve())


def _env(overrides: dict | None = None) -> dict:
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    if overrides:
        env.update(overrides)
    return env


def _build_env_pool_queue(env_pool: dict[str, list[str]]) -> queue.Queue | None:
    """Turn the declared per_run_setup.env pool into a queue of per-worker env dicts."""
    if not env_pool:
        return None
    pool_size = len(next(iter(env_pool.values())))
    q: queue.Queue = queue.Queue()
    for i in range(pool_size):
        q.put({k: vals[i] for k, vals in env_pool.items()})
    return q


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _run_id(eval_id: int, config: str, replicate: int) -> str:
    return f"eval-{eval_id}-{config}-run-{replicate}"


def resolve_baseline(
    spec: str,
    workspace: Path,
    iteration: int,
) -> tuple[Path | None, str]:
    """Resolve a baseline spec into (skill_path or None, resolved_label).

    The label captures what was actually picked, including auto-degradation —
    e.g. `previous` becomes `none` when iteration-(N-1)/skill-state/ doesn't
    exist. The label is what gets recorded in the manifest so post-hoc
    inspection can tell what the run actually compared against.

    Returns:
      (None, "none")              for `none` or auto-degraded `previous`
      (Path, "iteration-K")       for `previous` (resolves to K=N-1) or `iteration-K`
      (Path, "path:/abs/path")    for `path:/abs/path`
    """
    validate_baseline_spec(spec)

    if spec == "none":
        return None, "none"

    if spec == "previous":
        if iteration <= 1:
            print(
                f"[baseline] iteration {iteration} has no previous; degrading to 'none'",
                file=sys.stderr, flush=True,
            )
            return None, "none"
        prev_state = workspace / f"iteration-{iteration - 1}" / "skill-state"
        if not prev_state.exists():
            print(
                f"[baseline] {prev_state} not found; degrading to 'none'",
                file=sys.stderr, flush=True,
            )
            return None, "none"
        return prev_state.resolve(), f"iteration-{iteration - 1}"

    if spec.startswith("iteration-"):
        n = int(spec.split("-", 1)[1])
        target = workspace / f"iteration-{n}" / "skill-state"
        if not target.exists():
            raise FileNotFoundError(
                f"baseline '{spec}': {target} not found. Either run iteration {n} first "
                f"or pick a different baseline."
            )
        return target.resolve(), f"iteration-{n}"

    if spec.startswith("path:"):
        path = Path(spec[len("path:"):]).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"baseline '{spec}': {path} not found")
        return path, f"path:{path}"

    raise ValueError(f"unhandled baseline spec: {spec}")


def dump_skill_state(skill_path: Path, iteration_dir: Path) -> Path:
    """Copy the live skill into iteration-N/skill-state/.

    Called at iterate-end so iteration N's snapshot reflects the version that
    was just tested under `current`. iteration N+1 with --baseline=previous
    will then resolve to this directory.

    If the destination already exists (e.g. user re-ran the same iteration),
    we wipe and re-copy — the live skill is the source of truth for "what was
    tested in this iteration"; staleness here would mislead future baselines.

    Safe because validate_skill_workspace rejects workspace inside skill_path,
    so iteration_dir is never under skill_path and copytree cannot recurse.
    """
    state_dir = iteration_dir / "skill-state"
    if state_dir.exists():
        shutil.rmtree(state_dir)
    shutil.copytree(skill_path, state_dir)
    return state_dir


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


def _read_grading_summary(run_dir: Path) -> dict | None:
    path = run_dir / "grading.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text()).get("summary") or {}
    except (json.JSONDecodeError, OSError):
        return None


def _executor_completed(run_dir: Path) -> bool:
    """True when the executor produced a usable transcript with a final event."""
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
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if ev.get("type") == "result":
                    return True
                if ev.get("type") == "step_finish":
                    if (ev.get("part") or {}).get("reason") == "stop":
                        return True
    except OSError:
        return False
    return False


def _grader_completed(run_dir: Path) -> bool:
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
    baseline_spec: str,
    baseline_resolved: str,
    baseline_path: Path | None,
    evals_json: Path,
    model: str | None,
    runs: list[dict],
    iteration_dir: Path,
    executor: str = EXECUTOR_CLAUDE,
    grader_executor: str | None = None,
    grader_model: str | None = None,
) -> dict:
    """Construct the initial manifest with all planned runs marked pending."""
    return {
        "version": MANIFEST_VERSION,
        "iteration": iteration,
        "skill_name": skill_name,
        "skill_path": str(skill_path),
        "baseline_spec": baseline_spec,
        "baseline_resolved": baseline_resolved,
        "baseline_path": str(baseline_path) if baseline_path else None,
        "evals_json_path": str(evals_json),
        "model": model,
        "executor": executor,
        "grader_model": grader_model,
        "grader_executor": grader_executor,
        "configs": [CONFIG_CURRENT, CONFIG_BASELINE],
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "runs": [
            {
                "id": _run_id(r["eval_id"], r["config"], r["run_number"]),
                "eval_id": r["eval_id"],
                "eval_name": r["eval_name"],
                "config": r["config"],
                "replicate": r["run_number"],
                "path": str(r["run_dir"].relative_to(iteration_dir)),
                "status": STATUS_PENDING,
            }
            for r in runs
        ],
    }


def _refresh_manifest_runs(iteration_dir: Path, manifest: dict) -> dict:
    """Walk per-run status files + grading.json and update the manifest in place."""
    for entry in manifest.get("runs", []):
        run_dir = iteration_dir / entry["path"]
        status_data = _read_run_status(run_dir) or {}
        if status_data.get("status"):
            entry["status"] = status_data["status"]
        for fail_field in (
            "executor_exit_code", "executor_timed_out",
            "grader_exit_code", "grader_timed_out",
            "setup_exit_code", "setup_timed_out",
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
    env_overrides: dict | None = None,
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
                env=_env(env_overrides),
                timeout=timeout,
            )
            return result.returncode, False
        except subprocess.TimeoutExpired:
            return -1, True


def _run_setup_script(
    script_path: Path,
    run_dir: Path,
    env_overrides: dict | None,
    timeout: int,
) -> tuple[int, bool]:
    """Execute `per_run_setup.script` before the executor subprocess."""
    run_dir.mkdir(parents=True, exist_ok=True)
    setup_stdout = run_dir / "setup_stdout.log"
    setup_stderr = run_dir / "setup_stderr.log"
    with open(setup_stdout, "w") as out, open(setup_stderr, "w") as err:
        try:
            result = subprocess.run(
                [str(script_path)],
                stdout=out,
                stderr=err,
                cwd=str(run_dir),
                env=_env(env_overrides),
                timeout=timeout,
            )
            return result.returncode, False
        except subprocess.TimeoutExpired:
            return -1, True
        except (OSError, PermissionError) as e:
            err.write(f"\n[runner] failed to invoke setup script: {e}\n")
            return -1, False


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
    outputs_dir: str,
) -> str:
    """Construct the executor prompt: skill hint + outputs hint + input files + user prompt.

    `files` and `outputs_dir` are relative paths inside the executor's cwd
    (staged by run_executor). `skill_path`, when set, is still absolute — current
    config explicitly mounts the live skill, so its location is part of the contract.
    """
    lines = []
    if skill_path:
        lines.append(f"Use the skill at {skill_path}. Save any outputs to {outputs_dir}/.")
    else:
        lines.append(f"Save any outputs to {outputs_dir}/.")
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
    env_overrides: dict | None = None,
    applied_env_keys: list[str] | None = None,
    executor: str = EXECUTOR_CLAUDE,
) -> dict:
    """Run one executor subprocess; write timing.json; return result dict."""
    run_dir.mkdir(parents=True, exist_ok=True)
    run_outputs = (run_dir / "outputs").resolve()
    run_outputs.mkdir(exist_ok=True)
    transcript = run_dir / "transcript.jsonl"
    stderr = run_dir / "stderr.log"

    iso_cwd = _isolated_cwd(run_dir)
    iso_outputs = iso_cwd / "outputs"
    if iso_outputs.exists():
        shutil.rmtree(iso_outputs)
    iso_outputs.mkdir(parents=True)
    relative_files = _stage_inputs(iso_cwd, files)

    envelope = build_executor_envelope(skill_path, prompt, relative_files, "outputs")

    spawn = run_opencode if executor == EXECUTOR_OPENCODE else run_claude_p
    start_iso, start_wall = _now_iso(), time.time()
    try:
        exit_code, timed_out = spawn(
            prompt=envelope,
            cwd=iso_cwd,
            transcript_path=transcript,
            stderr_path=stderr,
            timeout=timeout,
            model=model,
            env_overrides=env_overrides,
        )
    finally:
        _collect_outputs(iso_outputs, run_outputs)
    end_wall, end_iso = time.time(), _now_iso()

    if executor == EXECUTOR_OPENCODE:
        parsed = parse_opencode_final_event(transcript)
    else:
        parsed = parse_result_event(transcript)
    timing = {
        **parsed,
        "executor_start": start_iso,
        "executor_end": end_iso,
        "executor_duration_seconds": end_wall - start_wall,
    }
    if executor == EXECUTOR_OPENCODE and not timing.get("duration_ms"):
        timing["duration_ms"] = int((end_wall - start_wall) * 1000)
        timing["total_duration_seconds"] = end_wall - start_wall
    (run_dir / "timing.json").write_text(json.dumps(timing, indent=2))

    extra_status: dict = {}
    if applied_env_keys:
        extra_status["applied_env_keys"] = applied_env_keys

    if exit_code == 0 and not timed_out:
        _write_run_status(run_dir, STATUS_EXECUTED, executor_completed_at=end_iso, **extra_status)
    else:
        _write_run_status(
            run_dir,
            STATUS_FAILED,
            executor_completed_at=end_iso,
            executor_exit_code=exit_code,
            executor_timed_out=timed_out,
            **extra_status,
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
    grader_executor: str = EXECUTOR_CLAUDE,
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
    user_prompt = (
        "Grade this run against the expectations below.\n"
        "\n"
        f"Expectations:\n{expectations_block}\n"
        "\n"
        f"transcript_path: {transcript}\n"
        f"outputs_dir: {outputs_dir}\n"
        "\n"
        f"Write grading.json to: {grading_path}\n"
    )

    iso_cwd = _isolated_cwd(run_dir)

    start_iso, start_wall = _now_iso(), time.time()
    if grader_executor == EXECUTOR_OPENCODE:
        merged_prompt = (
            f"{grader_system_prompt}\n\n---\n\n{user_prompt}"
            "Follow the instructions above.\n"
        )
        exit_code, timed_out = run_opencode(
            prompt=merged_prompt,
            cwd=iso_cwd,
            transcript_path=grader_transcript,
            stderr_path=grader_stderr,
            timeout=timeout,
            model=model,
        )
    else:
        exit_code, timed_out = run_claude_p(
            prompt=user_prompt + "Follow your system-prompt instructions.\n",
            cwd=iso_cwd,
            transcript_path=grader_transcript,
            stderr_path=grader_stderr,
            timeout=timeout,
            model=model,
            append_system_prompt=grader_system_prompt,
        )
    end_wall, end_iso = time.time(), _now_iso()
    grader_duration = end_wall - start_wall

    timing_path = run_dir / "timing.json"
    timing = json.loads(timing_path.read_text()) if timing_path.exists() else {}
    timing["grader_start"] = start_iso
    timing["grader_end"] = end_iso
    timing["grader_duration_seconds"] = grader_duration
    timing_path.write_text(json.dumps(timing, indent=2))

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
        _write_run_status(
            run_dir,
            STATUS_GRADED,
            grader_completed_at=end_iso,
            grader_executor=grader_executor,
            grader_model=model,
        )
    else:
        _write_run_status(
            run_dir,
            STATUS_FAILED,
            grader_completed_at=end_iso,
            grader_executor=grader_executor,
            grader_model=model,
            grader_exit_code=exit_code,
            grader_timed_out=timed_out,
        )

    return {
        "exit_code": exit_code,
        "timed_out": timed_out,
        "grading_exists": grading_path.exists(),
        "grading_summary": grading_summary,
    }


def plan_runs(
    config: EvalsConfig,
    workspace: Path,
    iteration: int,
    skill_path: Path,
    evals_json: Path,
    baseline_path: Path | None,
    default_timeout: int,
    runs_per_config: int,
) -> list[dict]:
    """Expand cases × {current, baseline} into per-run specs."""
    iteration_dir = workspace / f"iteration-{iteration}"
    runs: list[dict] = []
    for case in config.cases:
        eval_dir = iteration_dir / f"eval-{case.id}"
        eval_dir.mkdir(parents=True, exist_ok=True)

        parts = config.resolve_prompt_parts(case, evals_json)
        prompt = parts["prompt"]
        eval_name = case.name or f"eval-{case.id}"
        expectations = list(case.expectations)
        resolved_files = [_resolve_case_file(f, evals_json) for f in case.files]

        metadata = {
            "eval_id": case.id,
            "eval_name": eval_name,
            "prompt": prompt,
            "prompt_template_path": parts["prompt_template_path"],
            "prompt_template_content": parts["prompt_template_content"],
            "prompt_file_path": parts["prompt_file_path"],
            "prompt_file_content": parts["prompt_file_content"],
            "assertions": expectations,
        }
        (eval_dir / "eval_metadata.json").write_text(json.dumps(metadata, indent=2))

        common = {
            "eval_id": case.id,
            "eval_name": eval_name,
            "prompt": prompt,
            "files": resolved_files,
            "expectations": expectations,
            "timeout": case.timeout_s or default_timeout,
            "case_env": dict(case.env),
        }

        # Each case runs both configs. `current` always mounts the live skill;
        # `baseline` mounts whatever was resolved (or no skill if None).
        config_to_skill = {
            CONFIG_CURRENT: skill_path,
            CONFIG_BASELINE: baseline_path,
        }
        for k in range(1, runs_per_config + 1):
            for cfg_name, cfg_skill in config_to_skill.items():
                runs.append({
                    **common,
                    "config": cfg_name,
                    "run_number": k,
                    "run_dir": eval_dir / cfg_name / f"run-{k}",
                    "skill_path": cfg_skill,
                })

    return runs


def _run_one(
    r: dict,
    model: str | None,
    setup_script: Path | None,
    env_pool_q: queue.Queue | None,
    executor: str = EXECUTOR_CLAUDE,
) -> dict:
    """One worker's full per-run lifecycle."""
    pool_slot: dict | None = env_pool_q.get() if env_pool_q is not None else None
    case_env: dict = r.get("case_env") or {}
    try:
        run_dir: Path = r["run_dir"]

        env_overrides: dict | None = None
        if pool_slot or case_env:
            env_overrides = {}
            if pool_slot:
                env_overrides.update(pool_slot)
            if case_env:
                env_overrides.update(case_env)
        applied_env_keys = sorted(env_overrides.keys()) if env_overrides else []

        if setup_script is not None:
            setup_exit, setup_timed_out = _run_setup_script(
                script_path=setup_script,
                run_dir=run_dir,
                env_overrides=env_overrides,
                timeout=r["timeout"],
            )
            if setup_exit != 0 or setup_timed_out:
                fail_extra: dict = {
                    "setup_exit_code": setup_exit,
                    "setup_timed_out": setup_timed_out,
                }
                if applied_env_keys:
                    fail_extra["applied_env_keys"] = applied_env_keys
                _write_run_status(run_dir, STATUS_FAILED, **fail_extra)
                return {
                    "exit_code": -1,
                    "timed_out": False,
                    "timing": {},
                    "setup_failed": True,
                    "setup_exit_code": setup_exit,
                    "setup_timed_out": setup_timed_out,
                }

        return run_executor(
            run_dir=run_dir,
            skill_path=r["skill_path"],
            prompt=r["prompt"],
            files=r["files"],
            timeout=r["timeout"],
            model=model,
            env_overrides=env_overrides,
            applied_env_keys=applied_env_keys,
            executor=executor,
        )
    finally:
        if env_pool_q is not None and pool_slot is not None:
            env_pool_q.put(pool_slot)


def run_phase_executor(
    runs: list[dict],
    num_workers: int,
    model: str | None,
    resume: bool = False,
    env_pool: dict[str, list[str]] | None = None,
    setup_script: Path | None = None,
    executor: str = EXECUTOR_CLAUDE,
) -> list[dict]:
    """Run executor for all `runs`."""
    results = []
    todo = []
    skipped = 0
    for r in runs:
        if resume and _executor_completed(r["run_dir"]):
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

    env_pool_q = _build_env_pool_queue(env_pool or {})

    with ThreadPoolExecutor(max_workers=num_workers) as pool:
        futures = {
            pool.submit(
                _run_one,
                r,
                model,
                setup_script,
                env_pool_q,
                executor,
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
            if out.get("setup_failed"):
                status = f"FAIL setup exit={out.get('setup_exit_code')}"
            elif out.get("exit_code") == 0:
                status = "OK"
            else:
                status = f"FAIL exit={out.get('exit_code')}"
            print(
                f"[exec {done}/{len(todo)}] eval-{r['eval_id']}/{r['config']}/run-{r['run_number']} {status} "
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
    grader_executor: str = EXECUTOR_CLAUDE,
) -> list[dict]:
    """Run grader for each executor result."""
    results = []
    todo = []
    skipped_no_transcript = 0
    skipped_resume = 0
    for r in executor_results:
        if not _executor_completed(r["run_dir"]):
            results.append({
                "eval_id": r["eval_id"],
                "eval_name": r["eval_name"],
                "config": r["config"],
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
                "config": r["config"],
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
                grader_executor,
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
                f"[grade {done}/{len(todo)}] eval-{r['eval_id']}/{r['config']}/run-{r['run_number']} {status} "
                f"graded={gsum.get('passed', '?')}/{gsum.get('total', '?')}",
                file=sys.stderr,
                flush=True,
            )
            results.append({
                "eval_id": r["eval_id"],
                "eval_name": r["eval_name"],
                "config": r["config"],
                "run_number": r["run_number"],
                "run_dir": str(r["run_dir"]),
                **out,
            })
    return results


def _serialize_executor_result(r: dict) -> dict:
    return {
        "eval_id": r["eval_id"],
        "eval_name": r["eval_name"],
        "config": r["config"],
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
    baseline: str | None = None,
    num_workers: int | None = None,
    default_timeout: int | None = None,
    runs_per_config: int | None = None,
    phase: str = "all",
    resume: bool = False,
    skill_name: str | None = None,
) -> dict:
    """Library entry point: load + plan + execute + grade + manifest + skill-state dump."""
    evals_json = Path(evals_json).resolve()
    skill_path = Path(skill_path).resolve()
    workspace = Path(workspace).resolve()

    config = load_evals_config(evals_json)

    num_workers = num_workers if num_workers is not None else config.defaults.num_workers
    default_timeout = default_timeout if default_timeout is not None else config.defaults.timeout_s
    runs_per_config = runs_per_config if runs_per_config is not None else config.defaults.runs_per_config
    skill_name = skill_name or config.skill_name or skill_path.name
    model = config.default_model
    executor = config.executor
    grader_executor = config.grader_executor
    # Mirrors the runtime fallback in run_phase_grader: if grader_model is set
    # explicitly, use it; otherwise reuse executor model only when both phases
    # share a runtime; otherwise let the grader CLI choose its own default.
    if config.grader_model is not None:
        grader_model: str | None = config.grader_model
    elif grader_executor == executor:
        grader_model = model
    else:
        grader_model = None

    baseline_spec = baseline if baseline is not None else config.defaults.default_baseline
    validate_baseline_spec(baseline_spec)
    baseline_path, baseline_resolved = resolve_baseline(baseline_spec, workspace, iteration)

    per_run_setup = config.defaults.per_run_setup
    setup_script_path: Path | None = None
    if per_run_setup and per_run_setup.script:
        setup_script_path = (evals_json.parent / per_run_setup.script).resolve()
        if not setup_script_path.exists():
            raise FileNotFoundError(
                f"per_run_setup.script not found: {setup_script_path} "
                f"(declared in evals.json defaults.per_run_setup.script)"
            )
        if not os.access(setup_script_path, os.X_OK):
            raise PermissionError(
                f"per_run_setup.script not executable: {setup_script_path} (chmod +x?)"
            )
    env_pool_values: dict[str, list[str]] = (
        per_run_setup.env if per_run_setup else {}
    )

    runs = plan_runs(
        config=config,
        workspace=workspace,
        iteration=iteration,
        skill_path=skill_path,
        evals_json=evals_json,
        baseline_path=baseline_path,
        default_timeout=default_timeout,
        runs_per_config=runs_per_config,
    )

    iteration_dir = workspace / f"iteration-{iteration}"
    manifest = _build_manifest_skeleton(
        iteration=iteration,
        skill_name=skill_name,
        skill_path=skill_path,
        baseline_spec=baseline_spec,
        baseline_resolved=baseline_resolved,
        baseline_path=baseline_path,
        evals_json=evals_json,
        model=model,
        runs=runs,
        iteration_dir=iteration_dir,
        executor=executor,
        grader_executor=grader_executor,
        grader_model=grader_model,
    )
    _refresh_manifest_runs(iteration_dir, manifest)
    manifest_path = _write_manifest(iteration_dir, manifest)

    print(
        f"[plan] {len(config.cases)} cases × 2 configs (current + baseline={baseline_resolved}) = "
        f"{len(runs)} executor runs, phase={phase}, resume={resume}, executor={executor}",
        file=sys.stderr,
        flush=True,
    )

    executor_results: list[dict] = []
    if phase in ("all", "executor"):
        executor_results = run_phase_executor(
            runs,
            num_workers,
            model,
            resume=resume,
            env_pool=env_pool_values,
            setup_script=setup_script_path,
            executor=executor,
        )
        _refresh_manifest_runs(iteration_dir, manifest)
        _write_manifest(iteration_dir, manifest)
    else:
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
        grader_md_path = Path(__file__).resolve().parent / "data" / "agents" / "grader.md"
        if not grader_md_path.exists():
            raise FileNotFoundError(
                f"grader.md not found at {grader_md_path}. "
                f"If installed from source, run "
                f"`python packages/better-skills/sync_skill_data.py` "
                f"or reinstall with `pip install -e .` to populate scripts/data/."
            )
        grader_system_prompt = grader_md_path.read_text()
        grader_results = run_phase_grader(
            executor_results=executor_results,
            grader_system_prompt=grader_system_prompt,
            num_workers=num_workers,
            timeout=default_timeout,
            model=grader_model,
            resume=resume,
            grader_executor=grader_executor,
        )

    _refresh_manifest_runs(iteration_dir, manifest)
    _write_manifest(iteration_dir, manifest)

    # Snapshot the live skill into iteration-N/skill-state/. iterate-end is the
    # right time: the contents reflect what was just tested under `current`,
    # so iteration N+1 with --baseline=previous gets the correct reference.
    # Phase-only runs (e.g. grader-only re-grading) skip this; the iteration's
    # skill-state should reflect the executor run that produced the transcripts.
    if phase == "all":
        try:
            dump_skill_state(skill_path, iteration_dir)
            print(f"[snapshot] dumped skill-state to {iteration_dir / 'skill-state'}",
                  file=sys.stderr, flush=True)
        except (OSError, shutil.Error) as e:
            print(f"[snapshot] failed to dump skill-state: {e}", file=sys.stderr, flush=True)

    return {
        "iteration": iteration,
        "workspace": str(workspace),
        "iteration_dir": str(iteration_dir),
        "manifest_path": str(manifest_path),
        "skill_path": str(skill_path),
        "baseline_spec": baseline_spec,
        "baseline_resolved": baseline_resolved,
        "baseline_path": str(baseline_path) if baseline_path else None,
        "configs": [CONFIG_CURRENT, CONFIG_BASELINE],
        "phase": phase,
        "num_evals": len(config.cases),
        "num_runs": len(runs),
        "executors": [_serialize_executor_result(r) for r in executor_results],
        "graders": grader_results,
    }
