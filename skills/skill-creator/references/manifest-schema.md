# Iteration manifest schema

Each `iteration-N/` directory contains a `manifest.json` written by
`run_functional_eval.run_all` (and `iterate.py`). The manifest is the
explicit handoff between scripts in the pipeline — `aggregate_benchmark.py`,
`upload_dashboard.py`, and any other downstream tool reads it instead of
relying on glob-based directory walks. The on-disk run dirs remain the
ultimate source of truth; manifest is a fast index.

When a manifest is absent (e.g. a workspace produced before this format
existed), all consumers fall back to glob discovery.

## File layout

```
<workspace>/
└── iteration-N/
    ├── manifest.json                     # this file
    ├── benchmark.json                    # produced by aggregate_benchmark
    ├── benchmark.md
    ├── viewer.log                        # if launched via iterate
    └── eval-<id>/
        ├── eval_metadata.json
        └── <config>/                     # e.g. with_skill, without_skill, old_skill
            └── run-<k>/
                ├── transcript.jsonl
                ├── stderr.log
                ├── timing.json
                ├── grading.json
                ├── grader_transcript.jsonl
                ├── run_status.json       # status checkpoint, see below
                └── outputs/
```

## `manifest.json`

```jsonc
{
  "version": 1,
  "iteration": 3,
  "skill_name": "my-skill",
  "skill_path": "/abs/path/to/skill",
  "snapshot_path": "/abs/path/to/skill-snapshot",   // null when baseline=without_skill
  "baseline_mode": "old_skill",                      // "without_skill" | "old_skill"
  "evals_json_path": "/abs/path/to/evals.json",
  "model": "claude-opus-4-7",                        // null if not set
  "configs": ["with_skill", "old_skill"],            // declared variant names
  "created_at": "2026-04-26T12:00:00+00:00",
  "updated_at": "2026-04-26T12:42:13+00:00",
  "runs": [
    {
      "id": "eval-1-with_skill-run-1",
      "eval_id": 1,
      "eval_name": "first eval",
      "config": "with_skill",
      "replicate": 1,
      "path": "eval-1/with_skill/run-1",            // relative to iteration dir
      "status": "graded",                            // see status states below
      "executor_duration_s": 12.345,
      "grader_duration_s": 4.123,
      "tokens": 8400,
      "pass_rate": 1.0,
      "expectations_passed": 5,
      "expectations_total": 5,
      // Present only when status=failed; surfaces the failure detail without
      // requiring you to crawl into the run dir's run_status.json.
      "executor_exit_code": null,
      "executor_timed_out": null,
      "grader_exit_code": null,
      "grader_timed_out": null
    }
  ]
}
```

### Field notes

- **`configs`** drives `upload_dashboard.collect_runs` — only directories
  whose names appear here are considered for upload. Without a manifest the
  uploader falls back to a hardcoded set of the four known config names.
- **`runs[].path`** is always relative to the iteration dir, so manifests are
  movable across machines as long as the on-disk layout travels with them.
- **`runs[]` per-run metrics** (`executor_duration_s`, `tokens`, `pass_rate`,
  …) are derived from each run's `timing.json` + `grading.json` during
  `_refresh_manifest_runs`. They are convenience caches, not the source of
  truth — re-running `run_functional_eval` will recompute them.

## `run_status.json`

Written into each `<run-dir>/` by the executor and grader functions. Used
by `--resume` to decide whether a run can be skipped.

```jsonc
{
  "status": "graded",
  "updated_at": "2026-04-26T12:42:13+00:00",
  "executor_completed_at": "2026-04-26T12:30:00+00:00",
  "grader_completed_at": "2026-04-26T12:42:13+00:00"
}
```

### Status values

| Status     | Meaning                                                           |
|------------|-------------------------------------------------------------------|
| `pending`  | Planned but not yet executed (set in manifest skeleton)           |
| `executed` | Executor exited 0; transcript + outputs present                   |
| `graded`   | Grader exited 0 and `grading.json` exists                         |
| `failed`   | Executor or grader exited non-zero, or timed out                  |

`--resume` decides what to skip from on-disk artifacts, not from the
`status` field — that way a grader failure never forces an unnecessary
executor re-run:

- **Executor phase** skips a run whose `transcript.jsonl` already contains a
  final `result` event (verifiable proof the executor succeeded).
- **Grader phase** skips a run whose `grading.json` exists and parses.

The `status` field is updated to reflect the latest attempt; consult it for
display, not for resume gating.

## Lifecycle

1. **Plan** — `run_all` calls `plan_runs`, then `_build_manifest_skeleton`
   marks every planned run as `pending`. Before writing, the skeleton is
   refreshed against any existing on-disk state so a viewer reading mid-run
   never sees a freshly-blanked manifest. The manifest is written before any
   work starts so a crash mid-run still leaves a discoverable contract.
2. **Execute** — Each worker writes `run_status.json` to its own run dir
   when it finishes (`executed` or `failed`). No worker touches the
   manifest directly — there is no shared lock. After the executor pool
   joins, `run_all` refreshes + rewrites the manifest so the grader phase
   (and any concurrent reader) sees real status.
3. **Grade** — Only runs with a usable `transcript.jsonl` are queued; the
   rest are short-circuited as `failed` with `skipped_reason: no_transcript`.
   Each grader updates the run's status to `graded` or `failed`.
4. **Refresh** — At the end of `run_all`, `_refresh_manifest_runs` walks
   every run dir, reads `run_status.json` + `timing.json` + `grading.json`,
   and rebuilds the manifest's per-run entries. Idempotent — safe to call
   multiple times.

## Backward compatibility

Existing workspaces produced before manifests will not have one. Every
consumer falls back to glob discovery in that case:

- `aggregate_benchmark.load_run_results` — already discovers configs
  dynamically by listing iteration subdirectories.
- `upload_dashboard.collect_runs` — falls back to
  `DEFAULT_CONFIG_NAMES = {with_skill, without_skill, new_skill, old_skill}`.

So manifest is purely additive — no migration required.
