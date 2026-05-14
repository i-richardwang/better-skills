# better-skills

A measurement-first CLI for building and iterating on Claude Agent Skills.
Each iteration runs every test case under two configurations (`current` +
`baseline`), grades the trajectories, and tracks pass-rate deltas across
iterations.

## Install

```bash
pip install better-skills

better-skills --help
better-skills init <skill-path>                                          # scaffolds triggers.json inside the skill
better-skills init-evals <skill-path>-evals --skill-path <skill-path>    # scaffolds evals.json in a sibling dir
better-skills iterate \
  --skill-path <skill-path> \
  --evals-json <skill-path>-evals/evals.json \
  --workspace <name>-eval
better-skills view
```

## Repo layout

The CLI source lives in this package directory; the matching agent skill
(SKILL.md, authoring methodology, schemas, prompt templates) lives at
`<repo-root>/skills/better-skills/` in the
[skill-creator monorepo](https://github.com/i-richardwang/better-skills).

When the wheel is built, `setup.py` copies the runtime resources the CLI
reads (grader system prompt, eval viewer template) from the skill folder
into `scripts/data/` so the published wheel is self-contained.

For the authoring methodology and full skill documentation, read the
`SKILL.md` in the skill folder, or visit the repo above.
