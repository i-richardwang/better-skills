# better-skills dashboard

Web dashboard that archives and visualises **skill iteration history** —
benchmark trajectories, per-iteration SKILL.md diffs, and per-eval pass-rate
trends — across every skill that gets evaluated through the
[`better-skills`](../skills/better-skills/) CLI.

The CLI's `iterate` command writes a `manifest.json` + `benchmark.json` per
iteration locally, then POSTs the snapshot (skill files, raw benchmark,
per-run records) to this dashboard's HTTP API. From there you can browse
skills as a portfolio, drill into individual iterations, and watch metrics
evolve over time.

## What you get

- **Portfolio (`/`)** — every skill you've evaluated, latest pass rate,
  iteration count, last-upload timestamp, and a KPI strip (total skills /
  iterations / runs / runs-per-week).
- **Skill overview (`/skills/[name]`)** — iteration history table,
  trajectory charts (pass rate, tokens, time) showing `current` vs
  `baseline` per iteration.
- **Iteration detail (`/skills/[name]/iterations/[n]`)** — full SKILL.md
  diff against the previous iteration, per-eval breakdown, expectation
  matrix (which assertions pass/fail under `current` vs `baseline`).
- **Eval detail (`/skills/[name]/evals/[id]`)** — resource trajectories
  (time + tokens) and pass-rate trends scoped to a single eval case.

## Stack

| Layer | Tech |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack dev, standard prod build) |
| UI | React 19 + shadcn/ui + Tailwind CSS 4 + Recharts |
| ORM | Drizzle ORM 0.45 + `drizzle-kit` migrations |
| Database | PostgreSQL (any 14+ instance — no extensions required) |
| Runtime | Bun (lockfile is `bun.lock`; npm/pnpm work too) |

## Data model

Three tables, defined in `lib/db/schema.ts`:

- **`skills`** — one row per evaluated skill (name, latest iteration, last
  pass rate, timestamps).
- **`iterations`** — per-iteration snapshot. Stores the full skill source
  tree as `skill_files` (JSONB) and the raw benchmark as `raw_benchmark`
  (JSONB), plus the rolled-up metrics (pass rate mean/stddev, total
  tokens, total seconds).
- **`runs`** — individual run results within an iteration (eval id,
  configuration `"current"` or `"baseline"`, pass/fail counts, tokens,
  seconds, tool-call summary).

The JSONB-heavy design lets the dashboard answer "show me what the SKILL.md
looked like at iteration 3 vs iteration 7" without re-running anything —
the source is preserved alongside the metrics.

## Setup

### 1. Install dependencies

```bash
bun install   # or: npm install / pnpm install
```

### 2. Provision a PostgreSQL database

Any reachable Postgres works. Local Docker, Supabase, Neon, RDS — all
fine. No extensions needed.

### 3. Configure environment

Create `.env.local` (or `.env`) with:

```bash
# Postgres connection string (required)
DATABASE_URL=postgres://user:password@host:5432/dbname

# Shared secret for POST /api/uploads — generate a long random value.
# Set the same value as SKILL_DASHBOARD_TOKEN on the CLI host so the
# uploader passes it as a Bearer header.
DASHBOARD_UPLOAD_TOKEN=change-me-to-a-long-random-string
```

### 4. Apply migrations

```bash
bun run db:migrate
```

(or `db:push` for prototyping — migrations live in `drizzle/`.)

### 5. Run

```bash
bun run dev      # http://localhost:3000 — Turbopack dev
bun run build    # production build
bun run start    # serve the production build
```

`bun run db:studio` opens Drizzle Studio for inspecting tables locally.

## Uploading from the CLI

`better-skills iterate` finishes a run and silently posts the iteration
to `/api/uploads` with `Authorization: Bearer ${DASHBOARD_UPLOAD_TOKEN}`.
For manual one-off uploads use `better-skills upload <iteration-dir>
--skill-name <name> --iteration N --skill-path <path>`. Set both env
vars (`DATABASE_URL` and `DASHBOARD_UPLOAD_TOKEN`) on the dashboard
host, and on the CLI host set `SKILL_DASHBOARD_TOKEN` (matching value)
plus `SKILL_DASHBOARD_URL`.

## Operational notes

- **Database scope**: this DB only holds iteration/run/skill metadata.
  It's an "evaluation history archive" — orthogonal to any product
  database (e.g. you can run it next to talent-graph's PG without
  conflict).
- **No auth on read paths**: pages are open by default. Drop the dashboard
  behind a reverse proxy + auth (oauth2-proxy, Cloudflare Access, …) if
  you need access control.
- **No tests**: the dashboard relies on type-checking (`bun run
  typecheck`) and manual inspection — there's no test harness today.

## Scripts (tooling, not user-facing)

- `scripts/` — small one-off utilities (e.g. seed, prune). Run with
  `bun run scripts/<name>.ts`.

## Folder layout

```
dashboard/
├── app/                  # Next.js App Router pages + API routes
│   ├── api/skills/       # Read endpoints (skills / iterations / runs / evals)
│   ├── api/uploads/      # POST: ingest CLI iteration uploads
│   ├── skills/[name]/    # Skill overview, iteration detail, eval detail
│   └── page.tsx          # Portfolio / KPI strip
├── components/           # shadcn/ui + custom React components
├── drizzle/              # SQL migrations
├── lib/db/               # Drizzle schema + connection helper
├── lib/upload-auth.ts    # Bearer-token check for /api/uploads
├── hooks/                # Client-side hooks
└── public/               # Static assets
```
