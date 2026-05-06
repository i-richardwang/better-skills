"""Configuration models for better-skills evals.

Two config files per skill:

  <skill>/evals.json     — functional evals (case prompts + baseline declaration)
  <skill>/triggers.json  — trigger evals (description-triggering tests)

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
    prompt_file: str | None = Field(None, description="Path (relative to skill dir) to a markdown file containing the prompt.")
    files: list[str] = Field(default_factory=list, description="Input file paths mentioned in the executor prompt. Files must already exist on disk; this script does not materialize them. Relative paths are resolved against the skill directory (where evals.json lives) so they survive the runner's cwd isolation.")
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
        if not self.prompt and not self.prompt_file:
            raise ValueError(f"case id={self.id}: must set prompt or prompt_file")
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

    def resolve_prompt(self, case: CaseConfig, skill_path: Path) -> str:
        """Read the case's prompt — inline or from prompt_file relative to skill_path."""
        if case.prompt:
            return case.prompt
        assert case.prompt_file
        target = (skill_path / case.prompt_file).resolve()
        if not target.exists():
            raise FileNotFoundError(
                f"case id={case.id}: prompt_file '{case.prompt_file}' not found at {target}"
            )
        return target.read_text()


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


def find_evals_config(skill_path: Path) -> Path:
    """Default path for a skill's evals.json: <skill>/evals.json."""
    return skill_path / "evals.json"


def validate_skill_workspace(skill_path: Path, workspace: Path) -> None:
    """Reject workspace == skill_path. dump_skill_state would copytree the live
    skill into <iteration_dir>/skill-state/, and if iteration_dir lives directly
    under skill_path, copytree recurses through the destination it just wrote.

    Nesting workspace inside skill_path is allowed — the runner and dashboard
    uploader both prune the workspace subtree to keep that case sane.
    """
    if skill_path.resolve() == workspace.resolve():
        raise ConfigError(
            f"--workspace must not be the same directory as --skill-path "
            f"({skill_path}). Pick a workspace path that differs (a sibling or "
            f"a sub-directory like {skill_path}/workspace works)."
        )


def find_triggers_config(skill_path: Path) -> Path:
    """Default path for a skill's triggers.json: <skill>/triggers.json."""
    return skill_path / "triggers.json"
