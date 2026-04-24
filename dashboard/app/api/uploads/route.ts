import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { checkUploadAuth } from "@/lib/upload-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const incomingRunSchema = z.object({
  eval_id: z.number().int(),
  eval_name: z.string().optional(),
  configuration: z.enum(["with_skill", "without_skill"]),
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

function extractIterationSummary(benchmark: any) {
  const rs = benchmark?.run_summary ?? {};
  const ws = rs.with_skill ?? {};
  const wos = rs.without_skill ?? {};
  const meta = benchmark?.metadata ?? {};
  const evalsRun = Array.isArray(meta.evals_run) ? meta.evals_run.length : null;

  return {
    withSkillPassRateMean: toNumericString(ws.pass_rate?.mean),
    withSkillPassRateStddev: toNumericString(ws.pass_rate?.stddev),
    withoutSkillPassRateMean: toNumericString(wos.pass_rate?.mean),
    withoutSkillPassRateStddev: toNumericString(wos.pass_rate?.stddev),
    withSkillTokensMean: toReal(ws.tokens?.mean),
    withSkillTimeSecondsMean: toReal(ws.time_seconds?.mean),
    withoutSkillTokensMean: toReal(wos.tokens?.mean),
    withoutSkillTimeSecondsMean: toReal(wos.time_seconds?.mean),
    runsPerConfiguration: toInt(meta.runs_per_configuration),
    evalsCount: evalsRun,
    notes: toStringArray(benchmark?.notes),
  };
}

function buildBenchmarkRunMap(benchmark: any) {
  const map = new Map<string, any>();
  const runs = Array.isArray(benchmark?.runs) ? benchmark.runs : [];
  for (const r of runs) {
    const key = `${r.eval_id}-${r.configuration}-${r.run_number}`;
    map.set(key, r);
  }
  return map;
}

export async function POST(request: Request) {
  const auth = checkUploadAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
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
          const rr = br?.result ?? {};
          return {
            iterationId,
            evalId: r.eval_id,
            evalName: r.eval_name ?? br?.eval_name ?? null,
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
          latestPassRate: iterSummary.withSkillPassRateMean,
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
