"""Run trigger evaluation for a skill description.

Tests whether a skill's description causes the configured executor to
autonomously invoke the skill for a set of queries. CLI entry:
`scripts.cli trigger-eval`.
"""

import argparse
import json
import os
import select
import shutil
import subprocess
import sys
import time
import uuid
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from .config import find_triggers_config, load_triggers_config
from .run_functional_eval import EXECUTOR_CLAUDE, EXECUTOR_OPENCODE
from .utils import parse_skill_md


def find_project_root(executor: str = EXECUTOR_CLAUDE) -> Path:
    """Find the project root by walking up from cwd looking for the marker
    directory the chosen executor uses for project-local agent/command
    discovery (`.claude/` or `.opencode/`). Falls back to cwd."""
    marker = ".opencode" if executor == EXECUTOR_OPENCODE else ".claude"
    current = Path.cwd()
    for parent in [current, *current.parents]:
        if (parent / marker).is_dir():
            return parent
    return current


def _build_frontmatter_body(skill_name: str, skill_description: str, *, mode: str | None = None) -> str:
    """Frontmatter common to both runtimes' command/agent files. `mode` is
    OpenCode-specific (`subagent` for Task-tool delegation); pass None for
    Claude command files."""
    indented_desc = "\n  ".join(skill_description.split("\n"))
    head = f"---\ndescription: |\n  {indented_desc}\n"
    if mode:
        head += f"mode: {mode}\n"
    head += "---\n\n"
    return (
        f"{head}"
        f"# {skill_name}\n\n"
        f"This skill handles: {skill_description}\n"
    )


def _register_skill_file(
    *,
    executor: str,
    project_root: Path,
    skill_name: str,
    description: str,
    clean_name: str,
) -> Path:
    """Write the per-eval discovery file the chosen runtime uses to expose
    the skill to its primary model. Caller unlinks the returned path when
    the eval finishes.

    Per-eval (not per-run): with opencode + num_workers>1, parallel
    per-run files would all land in the shared `.opencode/agents/` and
    OpenCode's Task tool would surface every clone to every worker, so
    workers can delegate to siblings whose `subagent_type` doesn't match
    the calling worker's `clean_name`. One shared file = one subagent
    visible per worker."""
    if executor == EXECUTOR_OPENCODE:
        agents_dir = project_root / ".opencode" / "agents"
        agents_dir.mkdir(parents=True, exist_ok=True)
        path = agents_dir / f"{clean_name}.md"
        path.write_text(_build_frontmatter_body(skill_name, description, mode="subagent"))
        return path
    commands_dir = project_root / ".claude" / "commands"
    commands_dir.mkdir(parents=True, exist_ok=True)
    path = commands_dir / f"{clean_name}.md"
    path.write_text(_build_frontmatter_body(skill_name, description))
    return path


def _run_single_query_claude(
    query: str,
    timeout: int,
    project_root: str,
    model: str | None,
    clean_name: str,
) -> bool:
    """Claude Code path. Assumes the discovery file at
    `.claude/commands/<clean_name>.md` is already registered by the caller
    (run_eval). Uses --include-partial-messages so we can return as soon as
    the assistant decides which tool to invoke, rather than waiting for the
    tool to finish executing."""
    cmd = [
        "claude",
        "-p", query,
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
    ]
    if model:
        cmd.extend(["--model", model])

    # Drop CLAUDECODE so a nesting Claude Code session doesn't bleed into
    # the child; the guard is for interactive terminal conflicts only.
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        cwd=project_root,
        env=env,
    )

    triggered = False
    start_time = time.time()
    buffer = ""
    pending_tool_name = None
    accumulated_json = ""

    try:
        while time.time() - start_time < timeout:
            if process.poll() is not None:
                remaining = process.stdout.read()
                if remaining:
                    buffer += remaining.decode("utf-8", errors="replace")
                break

            ready, _, _ = select.select([process.stdout], [], [], 1.0)
            if not ready:
                continue

            chunk = os.read(process.stdout.fileno(), 8192)
            if not chunk:
                break
            buffer += chunk.decode("utf-8", errors="replace")

            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.strip()
                if not line:
                    continue

                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if event.get("type") == "stream_event":
                    se = event.get("event", {})
                    se_type = se.get("type", "")

                    if se_type == "content_block_start":
                        cb = se.get("content_block", {})
                        if cb.get("type") == "tool_use":
                            tool_name = cb.get("name", "")
                            if tool_name in ("Skill", "Read"):
                                pending_tool_name = tool_name
                                accumulated_json = ""
                            else:
                                return False

                    elif se_type == "content_block_delta" and pending_tool_name:
                        delta = se.get("delta", {})
                        if delta.get("type") == "input_json_delta":
                            accumulated_json += delta.get("partial_json", "")
                            if clean_name in accumulated_json:
                                return True

                    elif se_type in ("content_block_stop", "message_stop"):
                        if pending_tool_name:
                            return clean_name in accumulated_json
                        if se_type == "message_stop":
                            return False

                elif event.get("type") == "assistant":
                    message = event.get("message", {})
                    for content_item in message.get("content", []):
                        if content_item.get("type") != "tool_use":
                            continue
                        tool_name = content_item.get("name", "")
                        tool_input = content_item.get("input", {})
                        if tool_name == "Skill" and clean_name in tool_input.get("skill", ""):
                            triggered = True
                        elif tool_name == "Read" and clean_name in tool_input.get("file_path", ""):
                            triggered = True
                        return triggered

                elif event.get("type") == "result":
                    return triggered
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()

    return triggered


def _opencode_event_targets_subagent(event: dict, clean_name: str) -> bool:
    """True iff `event` is a tool_use that delegates to our registered
    subagent. OpenCode's NDJSON shape: `{"type": "tool_use", "part": {"tool":
    "task", "state": {"input": {"subagent_type": "<name>", ...}}}}`. We probe
    a couple of shapes defensively because the part schema has shifted across
    versions and the input may live under `state.input` or `input`."""
    if event.get("type") != "tool_use":
        return False
    part = event.get("part") or {}
    tool = (part.get("tool") or "").lower()
    if tool != "task":
        return False
    state = part.get("state") or {}
    inp = state.get("input") or part.get("input") or {}
    sub = inp.get("subagent_type") or ""
    return clean_name in sub


def _run_single_query_opencode(
    query: str,
    timeout: int,
    project_root: str,
    model: str | None,
    clean_name: str,
) -> bool:
    """OpenCode path. Assumes the discovery file at
    `.opencode/agents/<clean_name>.md` is already registered by the caller
    (run_eval). Watches the NDJSON stream for a Task-tool delegation
    referencing that name."""
    if not shutil.which("opencode"):
        raise FileNotFoundError(
            "opencode CLI not found on PATH. Install it (https://opencode.ai) "
            "or set executor=claude in triggers.json."
        )

    cmd = ["opencode", "run", "--format", "json", "--dangerously-skip-permissions", "--pure"]
    if model:
        cmd.extend(["--model", model])
    cmd.append(query)

    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        cwd=project_root,
        env=env,
    )

    start_time = time.time()
    buffer = ""

    try:
        while time.time() - start_time < timeout:
            if process.poll() is not None:
                remaining = process.stdout.read()
                if remaining:
                    buffer += remaining.decode("utf-8", errors="replace")
                break

            ready, _, _ = select.select([process.stdout], [], [], 1.0)
            if not ready:
                continue

            chunk = os.read(process.stdout.fileno(), 8192)
            if not chunk:
                break
            buffer += chunk.decode("utf-8", errors="replace")

            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if _opencode_event_targets_subagent(event, clean_name):
                    return True
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()

    # Final drain after the process exits naturally — there may be a tail
    # of buffered events we haven't scanned yet.
    for line in buffer.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if _opencode_event_targets_subagent(event, clean_name):
            return True

    return False


def run_single_query(
    query: str,
    timeout: int,
    project_root: str,
    clean_name: str,
    model: str | None = None,
    executor: str = EXECUTOR_CLAUDE,
) -> bool:
    """Run a single query and return whether the skill was triggered.

    Dispatches to the per-executor implementation. The discovery file at
    `clean_name` must already be registered by the caller (run_eval handles
    this once per eval; see _register_skill_file's docstring for why)."""
    if executor == EXECUTOR_OPENCODE:
        return _run_single_query_opencode(query, timeout, project_root, model, clean_name)
    return _run_single_query_claude(query, timeout, project_root, model, clean_name)


def run_eval(
    eval_set: list[dict],
    skill_name: str,
    description: str,
    num_workers: int,
    timeout: int,
    project_root: Path,
    runs_per_query: int = 1,
    trigger_threshold: float = 0.5,
    model: str | None = None,
    executor: str = EXECUTOR_CLAUDE,
) -> dict:
    """Run the full eval set and return results."""
    results = []

    unique_id = uuid.uuid4().hex[:8]
    clean_name = f"{skill_name}-skill-{unique_id}"
    skill_file = _register_skill_file(
        executor=executor,
        project_root=Path(project_root),
        skill_name=skill_name,
        description=description,
        clean_name=clean_name,
    )

    try:
        with ProcessPoolExecutor(max_workers=num_workers) as pool:
            future_to_info = {}
            for item in eval_set:
                for run_idx in range(runs_per_query):
                    future = pool.submit(
                        run_single_query,
                        item["query"],
                        timeout,
                        str(project_root),
                        clean_name,
                        model,
                        executor,
                    )
                    future_to_info[future] = (item, run_idx)

            query_triggers: dict[str, list[bool]] = {}
            query_items: dict[str, dict] = {}
            for future in as_completed(future_to_info):
                item, _ = future_to_info[future]
                query = item["query"]
                query_items[query] = item
                if query not in query_triggers:
                    query_triggers[query] = []
                try:
                    query_triggers[query].append(future.result())
                except Exception as e:
                    print(f"Warning: query failed: {e}", file=sys.stderr)
                    query_triggers[query].append(False)
    finally:
        if skill_file.exists():
            skill_file.unlink()

    for query, triggers in query_triggers.items():
        item = query_items[query]
        trigger_rate = sum(triggers) / len(triggers)
        should_trigger = item["should_trigger"]
        if should_trigger:
            did_pass = trigger_rate >= trigger_threshold
        else:
            did_pass = trigger_rate < trigger_threshold
        results.append({
            "query": query,
            "should_trigger": should_trigger,
            "trigger_rate": trigger_rate,
            "triggers": sum(triggers),
            "runs": len(triggers),
            "pass": did_pass,
        })

    passed = sum(1 for r in results if r["pass"])
    total = len(results)

    return {
        "skill_name": skill_name,
        "description": description,
        "results": results,
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
        },
    }


def run_from_cli(args: argparse.Namespace) -> dict:
    """Entry point used by `scripts.cli trigger-eval`."""
    skill_path = Path(args.skill_path).resolve()
    if not (skill_path / "SKILL.md").exists():
        raise FileNotFoundError(f"No SKILL.md found at {skill_path}")

    triggers_json = (
        Path(args.triggers_json).resolve() if args.triggers_json
        else find_triggers_config(skill_path).resolve()
    )
    cfg = load_triggers_config(triggers_json)
    eval_set = [q.model_dump() for q in cfg.queries]

    name, original_description, _ = parse_skill_md(skill_path)
    description = args.description or original_description
    executor = getattr(args, "executor", None) or cfg.executor
    project_root = find_project_root(executor)

    if args.verbose:
        print(f"Evaluating: {description}", file=sys.stderr)
        print(f"Executor: {executor}", file=sys.stderr)

    output = run_eval(
        eval_set=eval_set,
        skill_name=name,
        description=description,
        num_workers=args.num_workers or cfg.defaults.num_workers,
        timeout=args.timeout or cfg.defaults.timeout_s,
        project_root=project_root,
        runs_per_query=args.runs_per_query or cfg.defaults.runs_per_query,
        trigger_threshold=args.trigger_threshold or cfg.defaults.trigger_threshold,
        model=args.model or cfg.default_model,
        executor=executor,
    )

    if args.verbose:
        summary = output["summary"]
        print(f"Results: {summary['passed']}/{summary['total']} passed", file=sys.stderr)
        for r in output["results"]:
            status = "PASS" if r["pass"] else "FAIL"
            rate_str = f"{r['triggers']}/{r['runs']}"
            print(f"  [{status}] rate={rate_str} expected={r['should_trigger']}: {r['query'][:70]}", file=sys.stderr)

    return output
