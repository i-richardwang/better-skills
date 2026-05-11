"""OpenCode executor adapter for functional evals.

Counterpart to `run_claude_p()` in run_functional_eval.py. Same call shape so
the runner can dispatch to either executor with minimal branching.

This adapter trusts the same model the Claude path trusts: the executor agent
reads SKILL.md at the path the envelope points to and follows the instructions.
We do NOT mess with skill discovery isolation — the Claude path doesn't either,
and any leakage from a user's global `.claude/skills/` is symmetrical between
the two executors.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path


def build_opencode_cmd(
    model: str | None,
    prompt: str,
    cwd: Path,
) -> list[str]:
    """Construct the opencode argv. Prompt is the last positional arg.

    --dangerously-skip-permissions auto-approves all tool prompts (the runner
    can't field interactive permission asks from a subprocess).
    --pure skips external opencode plugins so the eval subprocess runs with
    a clean tool surface, regardless of what the user has configured globally.
    --dir is the agent's working directory. opencode does NOT inherit the
    Python subprocess's cwd — its server/agent decides its own cwd, so the
    runner's staged iso_cwd/inputs/ and iso_cwd/outputs/ are only visible to
    the agent when we pin --dir explicitly.
    """
    cmd = [
        "opencode", "run",
        "--format", "json",
        "--dangerously-skip-permissions",
        "--pure",
        "--dir", str(cwd),
    ]
    if model:
        cmd.extend(["--model", model])
    cmd.append(prompt)
    return cmd


def run_opencode(
    prompt: str,
    cwd: Path,
    transcript_path: Path,
    stderr_path: Path,
    timeout: int,
    model: str | None = None,
    env_overrides: dict | None = None,
) -> tuple[int, bool]:
    """Spawn an opencode subprocess. Returns (exit_code, timed_out).

    Mirrors run_claude_p's signature so run_executor can dispatch to either
    backend without changing call sites.
    """
    if not shutil.which("opencode"):
        raise FileNotFoundError(
            "opencode CLI not found on PATH. Install it (https://opencode.ai) "
            "or use --executor claude."
        )

    cmd = build_opencode_cmd(model=model, prompt=prompt, cwd=cwd)

    # Drop CLAUDECODE so an outer Claude Code session doesn't bleed into the
    # child; merge the per-run overrides on top. Same pattern as run_claude_p.
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    if env_overrides:
        env.update(env_overrides)

    cwd.mkdir(parents=True, exist_ok=True)
    with open(transcript_path, "w") as tfile, open(stderr_path, "w") as efile:
        try:
            result = subprocess.run(
                cmd,
                stdout=tfile,
                stderr=efile,
                text=True,
                cwd=str(cwd),
                env=env,
                timeout=timeout,
            )
            return result.returncode, False
        except subprocess.TimeoutExpired:
            return -1, True


def parse_opencode_final_event(transcript_path: Path) -> dict:
    """Sum tokens across step_finish events and return runner-shaped timing.

    OpenCode's stream emits a step_finish per processing step with `part.tokens`.
    We sum across all of them rather than reading only the reason=="stop" event,
    because tokens are reported per step (not cumulative) and the runner's
    billing/dashboard view treats total_tokens as the run's full LLM accounting.

    Duration is left at 0 here on purpose — runner wall-clock (computed in
    run_executor) is the truthful measurement and is backfilled by that caller.
    """
    total_input = 0
    total_output = 0
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
                if ev.get("type") != "step_finish":
                    continue
                tokens = (ev.get("part") or {}).get("tokens") or {}
                # Mirror Claude's accounting: input + output, count reasoning
                # as output (it's billed), ignore cache reads.
                total_input += int(tokens.get("input") or 0)
                total_output += int(tokens.get("output") or 0)
                total_output += int(tokens.get("reasoning") or 0)
    except FileNotFoundError:
        return {"total_tokens": 0, "duration_ms": 0, "total_duration_seconds": 0.0}

    return {
        "total_tokens": total_input + total_output,
        "duration_ms": 0,
        "total_duration_seconds": 0.0,
    }
