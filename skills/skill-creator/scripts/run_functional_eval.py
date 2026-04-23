#!/usr/bin/env python3
"""Run functional evals for a skill via `claude -p` subprocess.

For each eval in evals.json, spawns two `claude -p` subprocesses in parallel:
- with_skill: runs the task with the skill being tested
- baseline: either no skill (new-skill mode) or the old-skill snapshot (improving mode)

After executors complete, spawns a grader subprocess per run that evaluates
expectations against the transcript + outputs. Writes per-run directories with
transcript.jsonl, timing.json, grading.json. Outputs a summary JSON to stdout.

Collapses what used to be 6N agent-written bash calls (spawn + timing + grader
per run) into a single script call. Same spawn semantics as the previous
SKILL.md Step 1/3/4 template — stream-json + verbose, bypassPermissions,
timeout 600, env inherits everything except CLAUDECODE.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_TIMEOUT = 600
DEFAULT_WORKERS = 4


def _env() -> dict:
    # Drop CLAUDECODE so `claude -p` can nest inside a Claude Code session.
    # Same pattern as run_eval.py.
    return {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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

    # Backfill grader_duration_seconds into grading.json (grader can't know its own duration)
    grading_summary = None
    if grading_path.exists():
        try:
            grading = json.loads(grading_path.read_text())
            t = grading.setdefault("timing", {})
            t["grader_duration_seconds"] = grader_duration
            if "executor_duration_seconds" in t:
                t["total_duration_seconds"] = (
                    t["executor_duration_seconds"] + grader_duration
                )
            grading_path.write_text(json.dumps(grading, indent=2))
            grading_summary = grading.get("summary")
        except (json.JSONDecodeError, OSError):
            pass

    return {
        "exit_code": exit_code,
        "timed_out": timed_out,
        "grading_exists": grading_path.exists(),
        "grading_summary": grading_summary,
    }


def plan_runs(
    evals: list[dict],
    workspace: Path,
    iteration: int,
    skill_path: Path,
    baseline_mode: str,
    snapshot_path: Path | None,
    default_timeout: int,
    runs_per_config: int,
) -> list[dict]:
    """Expand evals into per-run specs. Writes eval_metadata.json into each eval dir.

    Directory layout matches aggregate_benchmark.py expectations:
      iteration-N/eval-<id>/<config>/run-<k>/{transcript.jsonl, timing.json, grading.json, outputs/}

    Eval dirs are always `eval-<id>` (not user-chosen names) so the aggregator's
    `eval-*` glob picks them up. Descriptive names live in eval_metadata.json.
    """
    iteration_dir = workspace / f"iteration-{iteration}"
    runs = []
    for ev in evals:
        eval_id = ev["id"]
        eval_dir = iteration_dir / f"eval-{eval_id}"
        eval_dir.mkdir(parents=True, exist_ok=True)

        metadata = {
            "eval_id": eval_id,
            "eval_name": ev.get("name") or f"eval-{eval_id}",
            "prompt": ev["prompt"],
            "assertions": ev.get("expectations", []),
        }
        (eval_dir / "eval_metadata.json").write_text(json.dumps(metadata, indent=2))

        common = {
            "eval_id": eval_id,
            "eval_name": metadata["eval_name"],
            "prompt": ev["prompt"],
            "files": ev.get("files", []),
            "expectations": ev.get("expectations", []),
            "timeout": ev.get("timeout", default_timeout),
        }

        for k in range(1, runs_per_config + 1):
            runs.append({
                **common,
                "variant": "with_skill",
                "run_number": k,
                "run_dir": eval_dir / "with_skill" / f"run-{k}",
                "skill_path": skill_path,
            })

            if baseline_mode == "without_skill":
                runs.append({
                    **common,
                    "variant": "without_skill",
                    "run_number": k,
                    "run_dir": eval_dir / "without_skill" / f"run-{k}",
                    "skill_path": None,
                })
            elif baseline_mode == "old_skill":
                runs.append({
                    **common,
                    "variant": "old_skill",
                    "run_number": k,
                    "run_dir": eval_dir / "old_skill" / f"run-{k}",
                    "skill_path": snapshot_path,
                })
            else:
                raise ValueError(f"Unknown baseline_mode: {baseline_mode}")

    return runs


def run_phase_executor(
    runs: list[dict],
    num_workers: int,
    model: str | None,
) -> list[dict]:
    results = []
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
            ): r for r in runs
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
                f"[exec {done}/{len(runs)}] eval-{r['eval_id']}/{r['variant']}/run-{r['run_number']} {status} "
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
) -> list[dict]:
    results = []
    with ThreadPoolExecutor(max_workers=num_workers) as pool:
        futures = {
            pool.submit(
                run_grader,
                r["run_dir"],
                r["expectations"],
                grader_system_prompt,
                timeout,
                model,
            ): r for r in executor_results
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
                f"[grade {done}/{len(executor_results)}] eval-{r['eval_id']}/{r['variant']}/run-{r['run_number']} {status} "
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


def main():
    parser = argparse.ArgumentParser(description="Run functional evals via claude -p")
    parser.add_argument("--evals-json", required=True, help="Path to evals.json")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory (with_skill variant)")
    parser.add_argument("--workspace", required=True, help="Workspace directory; iteration-N/ goes inside")
    parser.add_argument("--iteration", type=int, required=True)
    parser.add_argument("--baseline-mode", choices=["without_skill", "old_skill"], required=True)
    parser.add_argument("--snapshot-path", default=None, help="Path to old-skill snapshot (required when baseline-mode=old_skill)")
    parser.add_argument("--num-workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--default-timeout", type=int, default=DEFAULT_TIMEOUT)
    parser.add_argument("--runs-per-config", type=int, default=1,
                        help="Replicate each eval/config N times for variance analysis (default 1)")
    parser.add_argument("--model", default=None)
    parser.add_argument("--phase", choices=["all", "executor", "grader"], default="all",
                        help="'executor' only runs Step 1+3, 'grader' only runs Step 4 (expects existing transcripts).")
    parser.add_argument("--grader-md", default=None, help="Path to grader.md (default: <this-script>/../agents/grader.md)")
    args = parser.parse_args()

    if args.baseline_mode == "old_skill" and not args.snapshot_path:
        parser.error("--snapshot-path is required when --baseline-mode=old_skill")

    evals_data = json.loads(Path(args.evals_json).read_text())
    evals = evals_data.get("evals", [])

    skill_path = Path(args.skill_path).resolve()
    workspace = Path(args.workspace).resolve()
    snapshot_path = Path(args.snapshot_path).resolve() if args.snapshot_path else None

    runs = plan_runs(
        evals=evals,
        workspace=workspace,
        iteration=args.iteration,
        skill_path=skill_path,
        baseline_mode=args.baseline_mode,
        snapshot_path=snapshot_path,
        default_timeout=args.default_timeout,
        runs_per_config=args.runs_per_config,
    )

    print(f"[plan] {len(evals)} evals, {len(runs)} executor runs, phase={args.phase}", file=sys.stderr, flush=True)

    executor_results: list[dict] = []
    if args.phase in ("all", "executor"):
        executor_results = run_phase_executor(runs, args.num_workers, args.model)
    else:
        # grader-only: assume executor runs already exist in the planned directories
        executor_results = [{**r, "exit_code": 0, "timed_out": False, "timing": {}} for r in runs]

    grader_results: list[dict] | None = None
    if args.phase in ("all", "grader"):
        grader_md_path = Path(args.grader_md) if args.grader_md else (
            Path(__file__).resolve().parent.parent / "agents" / "grader.md"
        )
        if not grader_md_path.exists():
            print(f"[error] grader.md not found at {grader_md_path}", file=sys.stderr)
            sys.exit(1)
        grader_system_prompt = grader_md_path.read_text()
        grader_results = run_phase_grader(
            executor_results=executor_results,
            grader_system_prompt=grader_system_prompt,
            num_workers=args.num_workers,
            timeout=args.default_timeout,
            model=args.model,
        )

    summary = {
        "iteration": args.iteration,
        "workspace": str(workspace),
        "skill_path": str(skill_path),
        "baseline_mode": args.baseline_mode,
        "snapshot_path": str(snapshot_path) if snapshot_path else None,
        "phase": args.phase,
        "num_evals": len(evals),
        "num_runs": len(runs),
        "executors": [_serialize_executor_result(r) for r in executor_results],
        "graders": grader_results,
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
