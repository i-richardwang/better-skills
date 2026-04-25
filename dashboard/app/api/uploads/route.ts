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
  evals_definition: z.array(z.any()).optional(),
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

function extractIterationSummary(benchmark: unknown) {
  const b = asObj(benchmark);
  const rs = asObj(b.run_summary);
  const ws = asObj(rs.with_skill);
  const wos = asObj(rs.without_skill);
  const wsPass = asObj(ws.pass_rate);
  const wsTok = asObj(ws.tokens);
  const wsTime = asObj(ws.time_seconds);
  const wosPass = asObj(wos.pass_rate);
  const wosTok = asObj(wos.tokens);
  const wosTime = asObj(wos.time_seconds);
  const meta = asObj(b.metadata);
  const evalsRun = Array.isArray(meta.evals_run) ? meta.evals_run.length : null;

  return {
    withSkillPassRateMean: toNumericString(wsPass.mean),
    withSkillPassRateStddev: toNumericString(wsPass.stddev),
    withoutSkillPassRateMean: toNumericString(wosPass.mean),
    withoutSkillPassRateStddev: toNumericString(wosPass.stddev),
    withSkillTokensMean: toReal(wsTok.mean),
    withSkillTimeSecondsMean: toReal(wsTime.mean),
    withoutSkillTokensMean: toReal(wosTok.mean),
    withoutSkillTimeSecondsMean: toReal(wosTime.mean),
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
    evals_definition,
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
