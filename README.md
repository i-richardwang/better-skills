> **Origin:** Forked from [anthropics/skills](https://github.com/anthropics/skills) and reworked from a demo-skill catalogue into an eval-driven authoring toolchain — a `better-skills` CLI that owns the build / measure / iterate loop, plus a trajectory dashboard that archives every run. For the Agent Skills standard itself, see [agentskills.io](http://agentskills.io).

# better-skills

A measurement-first workbench for building and iterating on Agent Skills. Instead of writing a `SKILL.md` and hoping it triggers correctly, this repo treats every skill as something you instrument: each iteration runs every case under two fixed configurations — `current` (the live skill) and `baseline` (no skill, a prior iteration, or any skill directory) — using parallel `claude -p` evaluations, scores the trajectories, and watches the pass-rate delta evolve across iterations.

# How this differs from upstream

The original `anthropics/skills` is a curated catalogue of demonstration skills (docx, pdf, brand assets, etc.). This repo keeps spec compatibility but replaces the catalogue framing with a **build → measure → iterate loop**:

- A single CLI (`better-skills`) owns the whole lifecycle — scaffolding `evals.json`, snapshotting the live skill into `iteration-N/skill-state/` after every run (so the next iteration's `baseline=previous` resolves to the version that was just tested), running parallel evaluations, optimising descriptions for trigger accuracy, and uploading results.
- A pluggable grader / improver layer so eval scoring isn't tied to a single runtime (Claude and OpenCode supported alongside each other).
- A trajectory dashboard with per-iteration pass-rate diffs, so skill quality becomes a number you can watch move.
- An updated `SKILL.md` authoring methodology built around the eval loop rather than vibe-coding.

# What's in this repo

- **[`skills/better-skills`](./skills/better-skills)** — the meta-skill that teaches Claude *how to build other skills*, plus the Python CLI of the same name. See its [`SKILL.md`](./skills/better-skills/SKILL.md) for the authoring methodology and [`references/`](./skills/better-skills/references) for the eval / trigger schemas.
- **[`dashboard/`](./dashboard)** — a Next.js + PostgreSQL dashboard that archives every eval run and surfaces per-iteration pass-rate diffs.
- **[`spec/`](./spec)** — the Agent Skills specification this work follows.

# Installation

Install the `better-skills` CLI from the skill folder:

```bash
cd skills/better-skills
pip install -e .

# Now available on PATH:
better-skills --help
better-skills init <skill-path>
better-skills iterate --skill-path <skill-path> --workspace <name>-eval
better-skills view
```

To add the `better-skills` skill to a Claude Code project via [skills.sh](https://skills.sh):

```bash
npx skills add i-richardwang/better-skills      # project-local
npx skills add i-richardwang/better-skills -g   # global
```

# What is an Agent Skill?

A folder with a `SKILL.md` that has YAML frontmatter and instructions Claude follows when the skill triggers:

```markdown
---
name: my-skill-name
description: A clear description of what this skill does and when to use it
---

# My Skill Name

[Add your instructions here that Claude will follow when this skill is active]
```

The frontmatter requires only:
- `name` — unique identifier (lowercase, hyphens for spaces)
- `description` — what the skill does and when to use it

For background on the spec itself: [What are skills?](https://support.claude.com/en/articles/12512176-what-are-skills) · [Using skills in Claude](https://support.claude.com/en/articles/12512180-using-skills-in-claude) · [Creating custom skills](https://support.claude.com/en/articles/12512198-creating-custom-skills) · [Equipping agents for the real world with Agent Skills](https://anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills).
