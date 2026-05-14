"""Configuration models for better-skills evals.

Two config files per skill, kept in separate directories (skill = shippable
product, evals = test harness — same pattern as source vs tests in any project):

  <skill>/triggers.json          — trigger evals (description-triggering tests),
                                   lives inside the skill as product metadata.
  <evals-dir>/evals.json         — functional evals (case prompts + baseline
                                   declaration), lives outside the skill;
                                   conventionally `<skill-path>-evals/`.

Both are loaded and validated through pydantic models, giving precise field-level
errors when an agent (or human) writes a bad config. Errors point to the JSON
path so they are immediately actionable.

Functional eval comparison model (evals.json):

  Each iteration runs every case under exactly two configurations — `current`
  (the live skill) and `baseline` (resolved per `default_baseline`). The
  baseline grammar:

    none           → no skill mounted (bare model)
    previous       → iteration-(N-1)/skill-state/ (auto-snapshotted at iterate-end)
    iteration-N    → iteration-N/skill-state/
    path:/abs/path → mount whatever skill lives at /abs/path

  When `previous` resolves and the previous iteration's skill-state doesn't
  exist (typical for iteration 1), the runner auto-degrades to `none`.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


CONFIG_VERSION = 3


# --- Functional eval config -------------------------------------------------


# Grammar for `default_baseline` and the `--baseline` CLI flag. Validated up
# front so config errors surface at load time, not deep inside the runner.
_BASELINE_LITERAL = {"none", "previous"}
_BASELINE_ITERATION_RE = re.compile(r"^iteration-(\d+)$")
_BASELINE_PATH_RE = re.compile(r"^path:(.+)$")


def validate_baseline_spec(value: str) -> str:
    """Validate a baseline spec string. Returns the normalised form.

    Accepted: 'none' | 'previous' | 'iteration-N' (N>=1) | 'path:/abs/path'.
    The runner does the actual resolution against a workspace at run time;
    this is just a syntactic check so bad configs fail loud at load.
    """
    if value in _BASELINE_LITERAL:
        return value
    m = _BASELINE_ITERATION_RE.match(value)
    if m:
        n = int(m.group(1))
        if n < 1:
            raise ValueError(f"baseline 'iteration-{n}': N must be >= 1")
        return value
    m = _BASELINE_PATH_RE.match(value)
    if m:
        path = m.group(1)
        if not path:
            raise ValueError("baseline 'path:': path is empty")
        return value
    raise ValueError(
        f"invalid baseline spec '{value}': expected 'none', 'previous', "
        f"'iteration-N', or 'path:/abs/path'"
    )


class PerRunSetup(BaseModel):
    """Skill-level hooks for tests that need isolated external state.

    Two independent sub-fields (use either, both, or neither):

    * `env`: per-worker environment-variable pool. Each key maps to a list of
      values; one slot is checked out per running worker and returned when the
      run finishes. Use for resources where two parallel runs would clobber
      each other (databases, sandboxes, scratch dirs, ports, per-key API
      tokens). Same index across keys binds to the same worker, so cross-key
      consistency is guaranteed.

    * `script`: path (relative to skill dir) to an executable run before the
      executor subprocess. Inherits the run's full environment (including the
      env pool slot, if any). Non-zero exit or timeout marks the run FAILED
      and skips the executor — use for state resets, fixture seeding, etc.

    Most skills don't need this block. See references/evals-schema.md
    ("Per-run setup") for symptoms and copy-paste recipes.
    """

    model_config = ConfigDict(extra="forbid")

    env: dict[str, list[str]] = Field(
        default_factory=dict,
        description=(
            "Per-worker environment variable pool. Each key → list of values, "
            "one slot per worker thread. List length must be >= num_workers; "
            "multiple keys must be equal-length so same index binds to same worker."
        ),
    )
    script: str | None = Field(
        None,
        description=(
            "Path (relative to skill dir) to an executable invoked before each "
            "executor subprocess. Receives the run's full env (shell + pool slot "
            "+ case.env). Non-zero exit or timeout marks the run FAILED."
        ),
    )

    @model_validator(mode="after")
    def _check_env_lengths(self) -> "PerRunSetup":
        if not self.env:
            return self
        lengths = {k: len(v) for k, v in self.env.items()}
        for k, n in lengths.items():
            if n == 0:
                raise ValueError(f"per_run_setup.env['{k}']: must have at least one value")
        unique_lengths = set(lengths.values())
        if len(unique_lengths) > 1:
            raise ValueError(
                f"per_run_setup.env: all keys must have the same number of values "
                f"(got {lengths}); same index across keys binds to the same worker."
            )
        return self


class FunctionalDefaults(BaseModel):
    model_config = ConfigDict(extra="forbid")

    default_baseline: str = Field(
        "previous",
        description=(
            "What to compare `current` against. Grammar: 'none' (bare model), "
            "'previous' (iteration-(N-1)/skill-state/, auto-degrades to 'none' "
            "if absent), 'iteration-N' (specific past iteration), 'path:/abs' "
            "(any skill directory). Override per-invocation with --baseline."
        ),
    )
    runs_per_config: int = Field(1, ge=1, description="Replicate each (case × current/baseline) N times for variance.")
    timeout_s: int = Field(600, ge=1, description="Default per-run timeout in seconds.")
    num_workers: int = Field(4, ge=1, description="Parallel subprocess workers.")
    per_run_setup: PerRunSetup | None = Field(
        None,
        description=(
            "Skill-level isolation/setup for parallel tests with external mutable "
            "state. Most skills don't need this — leave unset. See "
            "references/evals-schema.md#per-run-setup for symptoms and recipes."
        ),
    )

    @model_validator(mode="after")
    def _check_baseline_grammar(self) -> "FunctionalDefaults":
        validate_baseline_spec(self.default_baseline)
        return self

    @model_validator(mode="after")
    def _check_pool_vs_workers(self) -> "FunctionalDefaults":
        if self.per_run_setup and self.per_run_setup.env:
            pool_size = len(next(iter(self.per_run_setup.env.values())))
            if pool_size < self.num_workers:
                raise ValueError(
                    f"per_run_setup.env: pool size {pool_size} < num_workers "
                    f"{self.num_workers}; declare at least num_workers values per "
                    f"key, or lower num_workers."
                )
        return self


class CaseConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int = Field(..., description="Stable integer ID; used for eval-<id>/ dir names.")
    name: str | None = Field(None, description="Human-readable label; falls back to 'eval-<id>'.")
    prompt: str | None = Field(None, description="Inline prompt body. Mutually exclusive with prompt_file.")
    prompt_file: str | None = Field(None, description="Path to a markdown file containing the case-specific prompt body. Resolved relative to evals.json's directory (or absolute).")
    prompt_template: str | None = Field(
        None,
        description=(
            "Optional path to a shared prompt template (project-level guidance, "
            "business constraints, output contract) that gets prepended to "
            "prompt_file/prompt with a blank-line separator. Resolved relative "
            "to evals.json's directory (or absolute). Use this when multiple "
            "cases share the same upper-layer prompt — declaring it here means "
            "the runner injects the template (no need to write 'go read X' in "
            "each prompt_file) and the dashboard captures the template content "
            "alongside each iteration."
        ),
    )
    files: list[str] = Field(default_factory=list, description="Input file paths the executor needs. Resolved relative to evals.json's dir, then staged into the executor's cwd at `inputs/<basename>` before the run; the envelope references them by basename so no project-tree path leaks. Basenames must be unique within a case.")
    expectations: list[str] = Field(default_factory=list, description="Assertion strings the grader checks against the transcript + outputs.")
    timeout_s: int | None = Field(None, ge=1, description="Override defaults.timeout_s for this case.")
    env: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Static environment variables specific to this case (case-level "
            "identity, e.g. {'FEATURE': 'A'} for one case, {'FEATURE': 'B'} "
            "for another). Layered on top of the shell env and any "
            "per_run_setup.env pool slot — case.env wins on key conflicts. "
            "These values are static across replicates and current/baseline of the "
            "case; for parallel-run isolation use per_run_setup.env instead."
        ),
    )

    @model_validator(mode="after")
    def _check_prompt(self) -> "CaseConfig":
        if not (self.prompt or self.prompt_file or self.prompt_template):
            raise ValueError(
                f"case id={self.id}: must set at least one of "
                f"prompt, prompt_file, or prompt_template"
            )
        if self.prompt and self.prompt_file:
            raise ValueError(f"case id={self.id}: prompt and prompt_file are mutually exclusive")
        return self


class EvalsConfig(BaseModel):
    """Top-level functional eval config (evals.json)."""

    model_config = ConfigDict(extra="forbid")

    version: int = Field(CONFIG_VERSION, description="Schema version. Migration script bumps this when format changes.")
    skill_name: str | None = Field(None, description="Skill identifier for manifest + dashboard. Defaults to the skill dir name.")
    default_model: str | None = Field(None, description="Model id for the executor subprocess. Use `provider/model` form (e.g. `anthropic/claude-opus-4-7`) when executor=opencode. The grader uses this same id only when grader_executor matches executor and grader_model is unset.")
    executor: Literal["claude", "opencode"] = Field("claude", description="Agent runtime for the executor subprocess.")
    grader_executor: Literal["claude", "opencode"] = Field("claude", description="Agent runtime for the grader subprocess. Independent of `executor` — pin this once per skill so grading stays consistent across iterations.")
    grader_model: str | None = Field(None, description="Model id for the grader subprocess. Use `provider/model` form when grader_executor=opencode. When unset, falls back to `default_model` if grader_executor matches executor, otherwise the chosen CLI's own default.")
    defaults: FunctionalDefaults
    cases: list[CaseConfig] = Field(..., min_length=1)

    @model_validator(mode="after")
    def _check_case_ids(self) -> "EvalsConfig":
        ids = [c.id for c in self.cases]
        if len(set(ids)) != len(ids):
            dups = [i for i in ids if ids.count(i) > 1]
            raise ValueError(f"duplicate case ids: {sorted(set(dups))}")
        return self

    def resolve_prompt_parts(self, case: CaseConfig, evals_json: Path) -> dict:
        """Read the case's prompt components.

        Returns a dict with the final concatenated `prompt` plus the individual
        pieces (`prompt_template_path`/`prompt_template_content`,
        `prompt_file_path`/`prompt_file_content`). Path/content fields are None
        when the corresponding evals.json field isn't declared. Used by the
        runner to write eval_metadata.json so the dashboard can see exactly
        what fed the executor and diff template vs. case body separately.

        Concat order: template first (sets context — business rules, output
        contract), then case body (the actual ask), separated by a blank line.
        """
        template_path: str | None = None
        template_content: str | None = None
        file_path: str | None = None
        file_content: str | None = None

        parts: list[str] = []

        if case.prompt_template:
            target = (evals_json.parent / case.prompt_template).resolve()
            if not target.exists():
                raise FileNotFoundError(
                    f"case id={case.id}: prompt_template '{case.prompt_template}' not found at {target}"
                )
            template_path = case.prompt_template
            template_content = target.read_text()
            parts.append(template_content)

        if case.prompt_file:
            target = (evals_json.parent / case.prompt_file).resolve()
            if not target.exists():
                raise FileNotFoundError(
                    f"case id={case.id}: prompt_file '{case.prompt_file}' not found at {target}"
                )
            file_path = case.prompt_file
            file_content = target.read_text()
            parts.append(file_content)
        elif case.prompt:
            parts.append(case.prompt)

        return {
            "prompt": "\n\n".join(parts),
            "prompt_template_path": template_path,
            "prompt_template_content": template_content,
            "prompt_file_path": file_path,
            "prompt_file_content": file_content,
        }

    def resolve_prompt(self, case: CaseConfig, evals_json: Path) -> str:
        """Read the case's prompt as a single string (template + body, concatenated)."""
        return self.resolve_prompt_parts(case, evals_json)["prompt"]


# --- Trigger eval config ----------------------------------------------------


class TriggerDefaults(BaseModel):
    model_config = ConfigDict(extra="forbid")

    runs_per_query: int = Field(3, ge=1)
    trigger_threshold: float = Field(0.5, ge=0.0, le=1.0)
    timeout_s: int = Field(30, ge=1)
    num_workers: int = Field(10, ge=1)
    max_iterations: int = Field(5, ge=1, description="For the eval+improve loop.")
    holdout: float = Field(0.4, ge=0.0, lt=1.0, description="Fraction held out for test split (0 = disabled).")


class TriggerQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(..., min_length=1)
    should_trigger: bool


class TriggersConfig(BaseModel):
    """Top-level trigger eval config (triggers.json)."""

    model_config = ConfigDict(extra="forbid")

    version: int = Field(CONFIG_VERSION)
    skill_name: str | None = None
    default_model: str | None = Field(None, description="Model id for the trigger-test subprocess. Use `provider/model` form when executor=opencode.")
    executor: Literal["claude", "opencode"] = Field("claude", description="Agent runtime that runs each trigger query.")
    improver_executor: Literal["claude", "opencode"] = Field("claude", description="Agent runtime that rewrites the description in trigger-loop. Independent of `executor`.")
    improver_model: str | None = Field(None, description="Model id for the description rewriter. When unset, falls back to `default_model` if improver_executor matches executor, otherwise the CLI's own default.")
    defaults: TriggerDefaults = Field(default_factory=TriggerDefaults)
    queries: list[TriggerQuery] = Field(..., min_length=1)


# --- Loaders ---------------------------------------------------------------


class ConfigError(Exception):
    """Raised when a config file is missing, malformed, or fails validation."""


def _load_json(path: Path) -> dict:
    if not path.exists():
        raise ConfigError(f"config file not found: {path}")
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as e:
        raise ConfigError(f"{path}: invalid JSON at line {e.lineno} col {e.colno}: {e.msg}") from e


def _format_validation_error(path: Path, e: ValidationError) -> str:
    lines = [f"{path}: validation failed ({len(e.errors())} error(s)):"]
    for err in e.errors():
        loc = ".".join(str(p) for p in err["loc"]) or "<root>"
        lines.append(f"  - {loc}: {err['msg']}")
    return "\n".join(lines)


def load_evals_config(path: Path) -> EvalsConfig:
    """Load and validate a functional evals.json. Raises ConfigError on any problem."""
    raw = _load_json(path)
    try:
        return EvalsConfig.model_validate(raw)
    except ValidationError as e:
        raise ConfigError(_format_validation_error(path, e)) from e


def load_triggers_config(path: Path) -> TriggersConfig:
    """Load and validate a triggers.json. Raises ConfigError on any problem."""
    raw = _load_json(path)
    try:
        return TriggersConfig.model_validate(raw)
    except ValidationError as e:
        raise ConfigError(_format_validation_error(path, e)) from e


def validate_skill_workspace(skill_path: Path, workspace: Path) -> None:
    """Reject workspace inside skill_path (including equality).

    skill_path is the live skill — what the agent reads. workspace is where
    iteration outputs accumulate. Putting workspace under skill_path means
    dump_skill_state's copytree of the live skill would recurse through the
    iteration output it just wrote, and the dashboard uploader's skill_files
    walk would sweep iteration artifacts into the payload.

    Eval harness data (evals.json, prompts/, seed/, setup scripts) belongs
    next to evals.json, not under skill_path. That's where file references
    in evals.json now resolve from.
    """
    skill_resolved = skill_path.resolve()
    workspace_resolved = workspace.resolve()
    if workspace_resolved == skill_resolved:
        raise ConfigError(
            f"--workspace must not be the same directory as --skill-path "
            f"({skill_path}). Place workspace outside the skill directory."
        )
    if skill_resolved in workspace_resolved.parents:
        raise ConfigError(
            f"--workspace ({workspace}) must not be nested inside --skill-path "
            f"({skill_path}). Place workspace alongside or outside the skill "
            f"directory — e.g. next to your evals.json."
        )


def find_triggers_config(skill_path: Path) -> Path:
    """Default path for a skill's triggers.json: <skill>/triggers.json."""
    return skill_path / "triggers.json"
