"""Configuration models for better-skills evals.

Two config files per skill:

  <skill>/evals.json     — functional evals (case prompts + variants for comparison)
  <skill>/triggers.json  — trigger evals (description-triggering tests)

Both are loaded and validated through pydantic models, giving precise field-level
errors when an agent (or human) writes a bad config. Errors point to the JSON
path so they are immediately actionable.

Variant model (functional evals): variants are data, not hardcoded strings. Each
variant has a `mount` describing what skill to attach for that comparison branch:

  mount=self      → mount the skill being iterated on (the canonical "with skill")
  mount=none      → no skill (bare baseline)
  mount=snapshot  → mount a snapshot dir (defaults to <workspace>/skill-snapshot/,
                    auto-created on first run, deleted to refresh)
  mount=path      → mount an explicit path; requires `path` field on the variant

`primary_variant` and `baseline_variant` decide the delta direction
(delta = primary - baseline). They reference variant names from the same config.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


CONFIG_VERSION = 2


# --- Functional eval config -------------------------------------------------


MountType = Literal["self", "none", "snapshot", "path"]


class VariantConfig(BaseModel):
    """One comparison branch. Names are user-chosen and become directory names
    on disk (iteration-N/eval-X/<variant-name>/run-K/) and labels in the
    benchmark output."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, description="Variant identifier; used as a directory name and dashboard label.")
    mount: MountType = Field(..., description="What skill to mount for this branch.")
    path: str | None = Field(None, description="Explicit skill path; required when mount=path.")
    description: str | None = None

    @model_validator(mode="after")
    def _check_path(self) -> "VariantConfig":
        if self.mount == "path" and not self.path:
            raise ValueError(f"variant '{self.name}': mount=path requires a 'path' field")
        if self.mount != "path" and self.path:
            raise ValueError(f"variant '{self.name}': 'path' is only valid when mount=path")
        return self


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

    primary_variant: str = Field(..., description="Variant whose results are the 'main' figure; delta = primary - baseline.")
    baseline_variant: str = Field(..., description="Variant the primary is compared against. Required: the comparison framing is what the dashboard, viewer, and benchmark.md all assume.")
    runs_per_variant: int = Field(1, ge=1, description="Replicate each (case × variant) N times for variance.")
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
    files: list[str] = Field(default_factory=list, description="Input file paths mentioned in the executor prompt. Files must already exist on disk; this script does not materialize them.")
    expectations: list[str] = Field(default_factory=list, description="Assertion strings the grader checks against the transcript + outputs.")
    timeout_s: int | None = Field(None, ge=1, description="Override defaults.timeout_s for this case.")
    env: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Static environment variables specific to this case (case-level "
            "identity, e.g. {'FEATURE': 'A'} for one case, {'FEATURE': 'B'} "
            "for another). Layered on top of the shell env and any "
            "per_run_setup.env pool slot — case.env wins on key conflicts. "
            "These values are static across replicates and variants of the "
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
    default_model: str | None = Field(None, description="Model id for the executor subprocess. Use `provider/model` form (e.g. `anthropic/claude-opus-4-7`) when executor=opencode. When executor=claude this same id is also used for the grader.")
    executor: Literal["claude", "opencode"] = Field("claude", description="Agent runtime for the executor subprocess. The grader runs on Claude with its CLI default model when executor=opencode.")
    variants: list[VariantConfig] = Field(..., min_length=1)
    defaults: FunctionalDefaults
    cases: list[CaseConfig] = Field(..., min_length=1)

    @model_validator(mode="after")
    def _check_variant_refs(self) -> "EvalsConfig":
        names = {v.name for v in self.variants}
        if len(names) != len(self.variants):
            dups = [v.name for v in self.variants if [x.name for x in self.variants].count(v.name) > 1]
            raise ValueError(f"duplicate variant names: {sorted(set(dups))}")
        if self.defaults.primary_variant not in names:
            raise ValueError(
                f"defaults.primary_variant '{self.defaults.primary_variant}' not in variants {sorted(names)}"
            )
        if self.defaults.baseline_variant not in names:
            raise ValueError(
                f"defaults.baseline_variant '{self.defaults.baseline_variant}' not in variants {sorted(names)}"
            )
        if self.defaults.baseline_variant == self.defaults.primary_variant:
            raise ValueError("defaults.baseline_variant cannot equal primary_variant")
        # Case IDs must be unique
        ids = [c.id for c in self.cases]
        if len(set(ids)) != len(ids):
            dups = [i for i in ids if ids.count(i) > 1]
            raise ValueError(f"duplicate case ids: {sorted(set(dups))}")
        return self

    def get_variant(self, name: str) -> VariantConfig:
        for v in self.variants:
            if v.name == name:
                return v
        raise KeyError(f"unknown variant: {name}")

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
    default_model: str | None = None
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


def find_triggers_config(skill_path: Path) -> Path:
    """Default path for a skill's triggers.json: <skill>/triggers.json."""
    return skill_path / "triggers.json"
