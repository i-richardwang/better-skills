import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { checkUploadAuth } from "@/lib/upload-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Each iteration runs exactly two configs — `current` and `baseline`. The
// upload API only accepts these two strings; anything else gets rejected at
// the schema layer so bad payloads never touch the DB.
const configurationName = z.enum(["current", "baseline"]);

// Allowed shapes for the `baseline_resolved` field reported in benchmark
// metadata: "none", "iteration-N" (N >= 1), or "path:/abs/path". Validated
// here defensively even though the python runner enforces the same grammar.
const baselineResolvedPattern = /^(none|iteration-\d+|path:.+)$/;

// Skill-relative POSIX path. Defense-in-depth against path traversal,
// absolute paths, Windows separators, and NULL bytes — the python scanner
// produces clean paths but the API must validate independently.
const skillFilePath = z
  .string()
  .min(1)
  .max(500)
  .refine((p) => !p.startsWith("/"), "absolute path not allowed")
  .refine((p) => !p.includes("\\"), "backslash not allowed")
  .refine((p) => !p.includes("\0"), "NULL byte not allowed")
  .refine(
    (p) =>
      !p
        .split("/")
        .some((seg) => seg === "" || seg === "." || seg === ".."),
    "invalid path segment",
  );

const MAX_SKILL_FILES = 500;
const MAX_SKILL_FILE_BYTES = 200_000;

const skillFilesSchema = z
  .record(skillFilePath, z.string().max(MAX_SKILL_FILE_BYTES))
  .refine(
    (m) => Object.keys(m).length <= MAX_SKILL_FILES,
    `too many entries (>${MAX_SKILL_FILES})`,
  );

const incomingRunSchema = z.object({
  eval_id: z.number().int(),
  eval_name: z.string().max(500).optional(),
  configuration: configurationName,
  run_number: z.number().int(),
  grading: z.any().optional(),
});

const bodySchema = z.object({
  skill_name: z.string().min(1).max(200),
  iteration_number: z.number().int().nonnegative(),
  benchmark: z.any(),
  runs: z.array(incomingRunSchema),
  skill_md: z.string().optional(),
  git_commit_sha: z.string().optional(),
  hostname: z.string().optional(),
  // evals_definition is the full evals.json (defaults + cases) so the
  // dashboard can render the case prompts that produced these results.
  evals_definition: z.any().optional(),
  // skill_files is the rest of the skill directory's text content
  // (sub-docs, agents, scripts) keyed by relative path. SKILL.md and
  // evals.json are excluded — they ride on their own fields above.
  skill_files: skillFilesSchema.optional(),
});

type Body = z.infer<typeof bodySchema>;

function toNumericString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v.toString();
  if (typeof v === "string" && v.length > 0 && !Number.isNaN(Number(v))) return v;
  return null;
}

function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.length > 0 && !Number.isNaN(Number(v)))
    return Math.trunc(Number(v));
  return null;
}

function toReal(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0 && !Number.isNaN(Number(v)))
    return Number(v);
  return null;
}

function toStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === "string");
}

type JsonObject = Record<string, unknown>;

function asObj(v: unknown): JsonObject {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as JsonObject)
    : {};
}

function configSummary(rs: JsonObject, config: "current" | "baseline") {
  const v = asObj(rs[config]);
  const pass = asObj(v.pass_rate);
  const tok = asObj(v.tokens);
  const tm = asObj(v.time_seconds);
  return {
    passMean: toNumericString(pass.mean),
    passStddev: toNumericString(pass.stddev),
    tokens: toReal(tok.mean),
    time: toReal(tm.mean),
  };
}

function asBaselineResolved(v: unknown): string | null {
  return typeof v === "string" && baselineResolvedPattern.test(v) ? v : null;
}

function extractIterationSummary(benchmark: unknown) {
  const b = asObj(benchmark);
  const meta = asObj(b.metadata);
  const rs = asObj(b.run_summary);

  const cur = configSummary(rs, "current");
  const bl = configSummary(rs, "baseline");

  const evalsRun = Array.isArray(meta.evals_run) ? meta.evals_run.length : null;

  return {
    baselineResolved: asBaselineResolved(meta.baseline_resolved),
    currentPassRateMean: cur.passMean,
    currentPassRateStddev: cur.passStddev,
    baselinePassRateMean: bl.passMean,
    baselinePassRateStddev: bl.passStddev,
    currentTokensMean: cur.tokens,
    currentTimeSecondsMean: cur.time,
    baselineTokensMean: bl.tokens,
    baselineTimeSecondsMean: bl.time,
    runsPerConfiguration: toInt(meta.runs_per_configuration),
    evalsCount: evalsRun,
    notes: toStringArray(b.notes),
  };
}

function buildBenchmarkRunMap(benchmark: unknown) {
  const b = asObj(benchmark);
  const map = new Map<string, JsonObject>();
  const runs = Array.isArray(b.runs) ? b.runs : [];
  for (const r of runs) {
    const obj = asObj(r);
    const key = `${obj.eval_id}-${obj.configuration}-${obj.run_number}`;
    map.set(key, obj);
  }
  return map;
}

// Single guard for every unbounded jsonb in the payload (raw_benchmark,
// evals_definition, runs[].grading). Cheaper than per-field caps and covers
// future fields by default.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
  const auth = checkUploadAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `Body too large (${declaredLength} > ${MAX_BODY_BYTES} bytes)` },
      { status: 413 },
    );
  }

  let parsed: Body;
  try {
    const json = await request.json();
    parsed = bodySchema.parse(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid JSON body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const {
    skill_name,
    iteration_number,
    benchmark,
    runs: incomingRuns,
    skill_md,
    git_commit_sha,
    hostname,
    evals_definition,
    skill_files,
  } = parsed;

  const iterSummary = extractIterationSummary(benchmark);
  const benchmarkRunMap = buildBenchmarkRunMap(benchmark);

  try {
    const result = await db.transaction(async (tx) => {
      // 1. upsert skill
      const [skillRow] = await tx
        .insert(schema.skills)
        .values({ name: skill_name })
        .onConflictDoUpdate({
          target: schema.skills.name,
          set: { updatedAt: sql`now()` },
        })
        .returning({ id: schema.skills.id });

      const skillId = skillRow.id;

      // 2. upsert iteration (latest wins)
      const iterationValues = {
        skillId,
        iterationNumber: iteration_number,
        ...iterSummary,
        skillMdSnapshot: skill_md ?? null,
        gitCommitSha: git_commit_sha ?? null,
        hostname: hostname ?? null,
        rawBenchmark: benchmark,
        evalsDefinition: evals_definition ?? null,
        skillFiles: skill_files ?? null,
      };

      const [iterationRow] = await tx
        .insert(schema.iterations)
        .values(iterationValues)
        .onConflictDoUpdate({
          target: [schema.iterations.skillId, schema.iterations.iterationNumber],
          set: {
            ...iterSummary,
            skillMdSnapshot: skill_md ?? null,
            gitCommitSha: git_commit_sha ?? null,
            hostname: hostname ?? null,
            rawBenchmark: benchmark,
            evalsDefinition: evals_definition ?? null,
            skillFiles: skill_files ?? null,
            uploadedAt: sql`now()`,
          },
        })
        .returning({ id: schema.iterations.id });

      const iterationId = iterationRow.id;

      // 3. clear existing runs for this iteration
      await tx.delete(schema.runs).where(eq(schema.runs.iterationId, iterationId));

      // 4. insert new runs
      if (incomingRuns.length > 0) {
        const runRows = incomingRuns.map((r) => {
          const key = `${r.eval_id}-${r.configuration}-${r.run_number}`;
          const br = benchmarkRunMap.get(key);
          const rr = asObj(br?.result);
          return {
            iterationId,
            evalId: r.eval_id,
            evalName:
              r.eval_name ??
              (typeof br?.eval_name === "string" ? br.eval_name : null),
            configuration: r.configuration,
            runNumber: r.run_number,
            passRate: toNumericString(rr.pass_rate),
            passed: toInt(rr.passed),
            total: toInt(rr.total),
            timeSeconds: toReal(rr.time_seconds),
            tokens: toInt(rr.tokens),
            toolCalls: toInt(rr.tool_calls),
            errors: toInt(rr.errors),
            notes: toStringArray(br?.notes),
            rawGrading: r.grading ?? null,
          };
        });
        await tx.insert(schema.runs).values(runRows);
      }

      // 5. update skill denormalized summary
      await tx
        .update(schema.skills)
        .set({
          latestIterationNumber: iteration_number,
          latestPassRate: iterSummary.currentPassRateMean,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.skills.id, skillId));

      return { skillId, iterationId };
    });

    return NextResponse.json({
      ok: true,
      skill_id: result.skillId,
      iteration_id: result.iterationId,
      runs_ingested: incomingRuns.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Upload failed", detail: message },
      { status: 500 },
    );
  }
}
