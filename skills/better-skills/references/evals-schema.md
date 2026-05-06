# Evals config schema

Two JSON files describe a skill's evals; both are validated by `scripts/config.py`:

- `evals.json` — functional eval cases + baseline declaration (consumed by `better-skills run/iterate`)
- `triggers.json` — trigger eval queries (consumed by `better-skills trigger-eval/trigger-loop`)

`better-skills init <skill-path>` scaffolds them at `<skill>/evals.json` and `<skill>/triggers.json` — the simplest layout. They can also live in a sibling harness directory (e.g. `<repo>/evals/<skill-name>/evals.json`) when you want to keep the skill folder clean; pass `--evals-json <path>` to point the CLI at the non-default location.

**Anchoring rule for file references.** All relative paths inside `evals.json` (`prompt_file`, `case.files`, `per_run_setup.script`) resolve against the directory containing **that evals.json file**, not against `--skill-path`. This means fixtures (prompts, seed data, setup scripts) co-locate naturally with the eval config, regardless of which layout you pick.

## evals.json

Each iteration runs every case under exactly two configurations: `current`
(the live skill at `--skill-path`) and `baseline` (resolved per
`default_baseline` or the `--baseline` CLI flag). After the runs finish, the
runner snapshots the live skill into `iteration-N/skill-state/` so future
iterations can compare against it.

```jsonc
{
  "version": 3,
  "skill_name": "my-skill",                    // optional; defaults to skill dir name
  "default_model": "claude-opus-4-7",          // executor model id; "provider/model" form when executor=opencode
  "executor": "claude",                        // "claude" or "opencode"
  "grader_executor": "claude",                 // "claude" or "opencode"; defaults to "claude"
  "grader_model": null,                        // grader model id; null = inherit default_model when grader_executor==executor, else CLI default

  "defaults": {
    "default_baseline": "previous",            // none | previous | iteration-N | path:/abs
    "runs_per_config": 1,                      // replicate count per case×config
    "timeout_s": 600,                          // per-run subprocess timeout
    "num_workers": 4,                          // parallel workers
    "per_run_setup": null                      // optional, advanced; see "Per-run setup" below
  },

  "cases": [
    {
      "id": 1,                                 // stable int; eval-<id>/ dir name
      "name": "make a chart",                  // optional human label
      "prompt": "Create a bar chart from ...", // inline OR prompt_file (XOR)
      "prompt_file": null,                     // path relative to evals.json's dir
      "files": [                               // file paths mentioned in prompt
        "data.csv"                             // relative paths resolve to <evals.json dir>/data.csv;
                                               // absolute paths pass through unchanged.
                                               // (must already exist; not materialized)
      ],
      "expectations": [                        // grader's pass/fail criteria
        "produces a chart with axis labels",
        "includes a title"
      ],
      "timeout_s": null,                       // override defaults.timeout_s
      "env": {}                                // per-case static env vars (see "Cases: env" below)
    }
  ]
}
```

### Baseline grammar

`default_baseline` (and the `--baseline` CLI override) take one of:

| Spec | What it points at |
|---|---|
| `none` | No skill mounted (bare model — the canonical "no skill" baseline) |
| `previous` | `iteration-(N-1)/skill-state/`, auto-degrades to `none` if absent (typical for iteration 1) |
| `iteration-K` | `iteration-K/skill-state/` for an explicit prior iteration. Pin to compare against a fixed historical version. |
| `path:/abs/path` | Mount any directory you point at — useful with `git worktree add`, or for comparing against a sibling skill. |

The runner records the resolved value in `manifest.json` as
`baseline_resolved` (e.g. `"iteration-2"` even if the spec was `"previous"`),
so post-hoc inspection knows what was actually compared against.

### Executor and grader runtimes

The grader is the measurement instrument: pin `grader_executor` and
`grader_model` once per skill and don't change them mid-campaign, otherwise
results stop being comparable across iterations.

When `grader_model` is null, the runner reuses `default_model` if
`grader_executor == executor`, otherwise lets the chosen CLI pick its own
default.

### Validation rules (enforced by pydantic)

- `default_baseline` must match the grammar above.
- Each case must set exactly one of `prompt` or `prompt_file`.
- Case IDs must be unique.
- `runs_per_config`, `timeout_s`, `num_workers` must be ≥ 1.
- `per_run_setup.env` (if set): every list must be non-empty, all keys equal
  length, and each list ≥ `num_workers`.
- `per_run_setup.script` (if set): file must exist under evals.json's
  directory and be executable. Validated when the runner starts, not when
  the config loads.

Bad configs fail with field-level error messages pointing at the JSON path:

```
config validation failed (2 error(s)):
  - defaults.default_baseline: invalid baseline spec 'iter-1': expected 'none', 'previous', 'iteration-N', or 'path:/abs/path'
  - cases.1: must set prompt or prompt_file
```

### Cases: `env`

Per-case static environment variables. Use this when different cases need
different values for the same variable — e.g., one case tests `FEATURE=A`,
another tests `FEATURE=B`:

```jsonc
"cases": [
  {"id": 1, "name": "feature A path", "prompt": "...", "env": {"FEATURE": "A"}},
  {"id": 2, "name": "feature B path", "prompt": "...", "env": {"FEATURE": "B"}}
]
```

Layered on top of the shell env — `case.env` wins on key conflicts. Case env
is **static across replicates and configs** of the same case: every parallel
run of case-1 sees `FEATURE=A`. Don't use it to provide isolation between
parallel replicates of the same case (use `per_run_setup.env` for that).

If most cases share the same env, prefer exporting in the shell before
launching the runner — keep `case.env` for values that genuinely differ
between cases.

### prompt vs prompt_file

For short inline prompts, use `prompt`. For multi-paragraph prompts (long
markdown bodies, embedded code blocks), put the prompt in its own `.md` file
and reference it via `prompt_file` (path is relative to evals.json's
directory). This keeps evals.json readable and lets prompts be edited like
normal markdown.

```jsonc
{
  "id": 1,
  "name": "complex task",
  "prompt_file": "evals/prompts/case-1.md"
}
```

## Advanced: `per_run_setup` — parallel external state

Most skills don't need this section. Skip it unless you recognize the
symptoms below.

### Symptoms — you probably need this if you see:

- Tests pass with `--num-workers 1` but fail with higher concurrency
- `database is locked` / `duplicate key` / `unique constraint violation`
- `address already in use` / port binding failures
- Playwright errors like *"user data directory is already in use"*
- Test artifacts from one run mysteriously leaking into another (cache, DB
  rows, files in a hardcoded path, webhook callbacks crossed over)

The common cause: your skill writes to or holds an external resource at a
fixed identifier (a DB URL, port, path, token), and parallel runs collide on
that one identifier. `per_run_setup` gives each in-flight run its own slot
of the resource, and optionally runs a setup script before each one.

### Recipe: testing a database-touching skill

Pre-create N empty test DBs once (e.g. `test_db_1` … `test_db_4`); the runner
hands one URL to each running worker, the script truncates between runs.

```jsonc
"defaults": {
  "num_workers": 4,
  "per_run_setup": {
    "env": {
      "DATABASE_URL": [
        "postgres://localhost/test_db_1",
        "postgres://localhost/test_db_2",
        "postgres://localhost/test_db_3",
        "postgres://localhost/test_db_4"
      ]
    },
    "script": "scripts/reset_db.sh"
  }
}
```

`scripts/reset_db.sh` (executable, located next to evals.json):
```bash
#!/usr/bin/env bash
set -euo pipefail
psql "$DATABASE_URL" -c "TRUNCATE TABLE users, orders RESTART IDENTITY CASCADE;"
```

The skill's code reads `$DATABASE_URL` to know which DB to talk to.

### Recipe: testing a browser-automation skill (Playwright)

Each parallel run needs its own user-data-dir; reusing one triggers profile
locks.

```jsonc
"defaults": {
  "num_workers": 4,
  "per_run_setup": {
    "env": {
      "PLAYWRIGHT_USER_DATA_DIR": [
        "/tmp/pw-profile-1",
        "/tmp/pw-profile-2",
        "/tmp/pw-profile-3",
        "/tmp/pw-profile-4"
      ]
    },
    "script": "scripts/clean_profile.sh"
  }
}
```

```bash
#!/usr/bin/env bash
rm -rf "$PLAYWRIGHT_USER_DATA_DIR" && mkdir -p "$PLAYWRIGHT_USER_DATA_DIR"
```

### Recipe: testing a webhook-receiver skill

Each run needs a unique receiver token so callbacks don't cross. No script
needed if the receiver is stateless (e.g. webhook.site tokens).

```jsonc
"defaults": {
  "num_workers": 4,
  "per_run_setup": {
    "env": {
      "WEBHOOK_URL": [
        "https://webhook.site/token-1",
        "https://webhook.site/token-2",
        "https://webhook.site/token-3",
        "https://webhook.site/token-4"
      ]
    }
  }
}
```

### Mechanism details

`per_run_setup` has two independent sub-fields. Use either, both, or neither.

#### `per_run_setup.env` — per-worker pool

A dict where each key maps to a list of values. The runner builds a queue of
slot dicts (one slot = one value per declared key) and hands a slot to each
worker thread for the duration of one run; the slot is returned to the queue
when the run finishes (even on crash, via `finally`).

- **Pool size** must be `>= num_workers` per key — runs never share a slot.
  Validation rejects smaller pools rather than silently looping.
- **Multiple keys must be equal-length.** Same index across keys binds to the
  same worker — `DATABASE_URL[2]` and `SCRATCH_DIR[2]` are always held by the
  same in-flight run, so the script and skill can rely on cross-key
  consistency (this is how you'd say "the worker holding `db_3` also gets
  `/tmp/scratch_3`").
- **Pool of size 1 is degenerate.** It forces `num_workers=1` and the value
  is just a constant — at that point, set `num_workers: 1` and put the value
  in shell env or `case.env` instead.
- The slot is acquired before the setup script (if any) runs.

#### `per_run_setup.script` — per-run setup hook

Path relative to evals.json's directory; must be executable. Invoked before
each executor subprocess with:

- **cwd** = the run's directory (`iteration-N/eval-X/<config>/run-K/`)
- **env** = the run's full environment (shell env + pool slot + `case.env`)
- **stdout/stderr** captured to `setup_stdout.log` / `setup_stderr.log`
  inside the run dir

A non-zero exit (or timeout) marks the run `failed`, surfaces
`setup_exit_code` / `setup_timed_out` in `run_status.json` and the manifest,
and **skips the executor** — there's no point running the test if its
prerequisites didn't establish.

Independent of `env`: it's just "run this script first". Pair them when you
need both (the typical pattern for DB testing: pool hands out N reusable
DBs, script truncates the assigned one before each run).

#### Env layering at runtime

Each run's executor (and the setup script) sees a merged environment built
in this order — later wins on key conflicts:

```
shell env  →  per_run_setup.env (worker slot)  →  cases[].env  →  executor
```

If a `case.env` key collides with a pool key, the case wins (the pool slot
is still consumed; the value is just overridden — slot is "wasted" but not
broken). The keys actually applied are recorded in `run_status.json` as
`applied_env_keys` so you can verify after the fact without leaking values.

## triggers.json

Trigger evals test whether the skill's *description* causes the configured
runtime to invoke the skill on relevant queries. No baseline — the variable
being tested is the description itself, mutated in-place by `trigger-improve`.

```jsonc
{
  "version": 3,
  "skill_name": "my-skill",
  "default_model": "claude-opus-4-7",          // model used by the trigger-test subprocess; provider/model form when executor=opencode
  "executor": "claude",                        // "claude" or "opencode" — runtime that runs each trigger query
  "improver_executor": "claude",               // "claude" or "opencode" — runtime that rewrites the description in trigger-loop
  "improver_model": null,                      // model id for the rewriter; null = inherit default_model when improver_executor==executor, else CLI default

  "defaults": {
    "runs_per_query": 3,                       // replicate per query
    "trigger_threshold": 0.5,                  // pass if rate ≥ this when should=true
    "timeout_s": 30,
    "num_workers": 10,
    "max_iterations": 5,                       // for trigger-loop
    "holdout": 0.4                             // fraction held out for test split
  },

  "queries": [
    {
      "query": "How do I make a bar chart?",
      "should_trigger": true
    },
    {
      "query": "What's the weather today?",
      "should_trigger": false
    }
  ]
}
```

Pin `executor` once per skill — trigger rates from different runtimes
aren't directly comparable.

### Validation rules

- At least one query.
- `trigger_threshold` ∈ [0, 1].
- `holdout` ∈ [0, 1).
- All defaults are optional and have sensible fallbacks.
