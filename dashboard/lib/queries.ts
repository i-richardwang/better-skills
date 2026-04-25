import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

export type SkillListRow = {
  name: string;
  latestIterationNumber: number | null;
  latestPassRate: number | null;
  iterationsCount: number;
  updatedAt: Date;
};

export async function listSkills(): Promise<SkillListRow[]> {
  const rows = await db
    .select({
      name: schema.skills.name,
      latestIterationNumber: schema.skills.latestIterationNumber,
      latestPassRate: schema.skills.latestPassRate,
      updatedAt: schema.skills.updatedAt,
      iterationsCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${schema.iterations}
        WHERE ${schema.iterations.skillId} = ${schema.skills.id}
      )`,
    })
    .from(schema.skills)
    .orderBy(desc(schema.skills.updatedAt));

  return rows.map((r) => ({
    name: r.name,
    latestIterationNumber: r.latestIterationNumber,
    latestPassRate: r.latestPassRate === null ? null : Number(r.latestPassRate),
    iterationsCount: r.iterationsCount,
    updatedAt: r.updatedAt,
  }));
}

export type PortfolioStats = {
  skillsCount: number;
  iterationsCount: number;
  runsCount: number;
  latestUpload: Date | null;
};

export async function getPortfolioStats(): Promise<PortfolioStats> {
  const [row] = await db.execute<{
    skills_count: number;
    iterations_count: number;
    runs_count: number;
    latest_upload: Date | null;
  }>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM ${schema.skills}) AS skills_count,
      (SELECT COUNT(*)::int FROM ${schema.iterations}) AS iterations_count,
      (SELECT COUNT(*)::int FROM ${schema.runs}) AS runs_count,
      (SELECT MAX(${schema.iterations.uploadedAt}) FROM ${schema.iterations}) AS latest_upload
  `);
  return {
    skillsCount: row.skills_count,
    iterationsCount: row.iterations_count,
    runsCount: row.runs_count,
    latestUpload: row.latest_upload,
  };
}

export type IterationPoint = {
  iterationNumber: number;
  withSkillMean: number | null;
  withSkillStddev: number | null;
  withoutSkillMean: number | null;
  withoutSkillStddev: number | null;
  withSkillTokensMean: number | null;
  withSkillTimeSecondsMean: number | null;
  withoutSkillTokensMean: number | null;
  withoutSkillTimeSecondsMean: number | null;
  runsPerConfiguration: number | null;
  evalsCount: number | null;
  gitCommitSha: string | null;
  hostname: string | null;
  uploadedAt: Date;
};

export type SkillTrajectory = {
  name: string;
  createdAt: Date;
  updatedAt: Date;
  latestIterationNumber: number | null;
  latestPassRate: number | null;
  points: IterationPoint[];
};

export async function getSkillTrajectory(
  name: string,
): Promise<SkillTrajectory | null> {
  const [skill] = await db
    .select()
    .from(schema.skills)
    .where(eq(schema.skills.name, name))
    .limit(1);
  if (!skill) return null;

  const iters = await db
    .select()
    .from(schema.iterations)
    .where(eq(schema.iterations.skillId, skill.id))
    .orderBy(asc(schema.iterations.iterationNumber));

  const toNum = (v: string | null) => (v === null ? null : Number(v));

  return {
    name: skill.name,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    latestIterationNumber: skill.latestIterationNumber,
    latestPassRate: toNum(skill.latestPassRate),
    points: iters.map((it) => ({
      iterationNumber: it.iterationNumber,
      withSkillMean: toNum(it.withSkillPassRateMean),
      withSkillStddev: toNum(it.withSkillPassRateStddev),
      withoutSkillMean: toNum(it.withoutSkillPassRateMean),
      withoutSkillStddev: toNum(it.withoutSkillPassRateStddev),
      withSkillTokensMean: it.withSkillTokensMean,
      withSkillTimeSecondsMean: it.withSkillTimeSecondsMean,
      withoutSkillTokensMean: it.withoutSkillTokensMean,
      withoutSkillTimeSecondsMean: it.withoutSkillTimeSecondsMean,
      runsPerConfiguration: it.runsPerConfiguration,
      evalsCount: it.evalsCount,
      gitCommitSha: it.gitCommitSha,
      hostname: it.hostname,
      uploadedAt: it.uploadedAt,
    })),
  };
}

export type Expectation = {
  text: string;
  passed: boolean;
  evidence: string | null;
};

export type EvalDefinition = {
  id: number;
  prompt: string | null;
  expectedOutput: string | null;
  files: string[] | null;
  expectations: string[] | null;
};

function extractEvalsDefinition(raw: unknown): EvalDefinition[] | null {
  if (!Array.isArray(raw)) return null;
  const out: EvalDefinition[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const o = e as {
      id?: unknown;
      prompt?: unknown;
      expected_output?: unknown;
      files?: unknown;
      expectations?: unknown;
    };
    if (typeof o.id !== "number") continue;
    out.push({
      id: o.id,
      prompt: typeof o.prompt === "string" ? o.prompt : null,
      expectedOutput:
        typeof o.expected_output === "string" ? o.expected_output : null,
      files: Array.isArray(o.files)
        ? o.files.filter((f): f is string => typeof f === "string")
        : null,
      expectations: Array.isArray(o.expectations)
        ? o.expectations.filter((x): x is string => typeof x === "string")
        : null,
    });
  }
  return out.length > 0 ? out : null;
}

export type RunRow = {
  id: number;
  evalId: number;
  evalName: string | null;
  configuration: "with_skill" | "without_skill";
  runNumber: number;
  passRate: number | null;
  passed: number | null;
  total: number | null;
  timeSeconds: number | null;
  tokens: number | null;
  toolCalls: number | null;
  errors: number | null;
  notes: string[] | null;
  expectations: Expectation[];
};

function extractExpectations(rawGrading: unknown): Expectation[] {
  if (!rawGrading || typeof rawGrading !== "object") return [];
  const exp = (rawGrading as { expectations?: unknown }).expectations;
  if (!Array.isArray(exp)) return [];
  return exp
    .map((e): Expectation | null => {
      if (!e || typeof e !== "object") return null;
      const o = e as { text?: unknown; passed?: unknown; evidence?: unknown };
      if (typeof o.text !== "string" || typeof o.passed !== "boolean")
        return null;
      return {
        text: o.text,
        passed: o.passed,
        evidence: typeof o.evidence === "string" ? o.evidence : null,
      };
    })
    .filter((e): e is Expectation => e !== null);
}

export type IterationDetail = {
  skillName: string;
  iterationNumber: number;
  withSkillMean: number | null;
  withSkillStddev: number | null;
  withoutSkillMean: number | null;
  withoutSkillStddev: number | null;
  withSkillTokensMean: number | null;
  withSkillTimeSecondsMean: number | null;
  withoutSkillTokensMean: number | null;
  withoutSkillTimeSecondsMean: number | null;
  runsPerConfiguration: number | null;
  evalsCount: number | null;
  notes: string[] | null;
  skillMdSnapshot: string | null;
  gitCommitSha: string | null;
  hostname: string | null;
  uploadedAt: Date;
  evalsDefinition: EvalDefinition[] | null;
  runs: RunRow[];
};

export async function getIterationDetail(
  name: string,
  iterationNumber: number,
): Promise<IterationDetail | null> {
  const [skill] = await db
    .select()
    .from(schema.skills)
    .where(eq(schema.skills.name, name))
    .limit(1);
  if (!skill) return null;

  const [iter] = await db
    .select()
    .from(schema.iterations)
    .where(
      and(
        eq(schema.iterations.skillId, skill.id),
        eq(schema.iterations.iterationNumber, iterationNumber),
      ),
    )
    .limit(1);
  if (!iter) return null;

  const runs = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.iterationId, iter.id))
    .orderBy(
      asc(schema.runs.evalId),
      asc(schema.runs.configuration),
      asc(schema.runs.runNumber),
    );

  const toNum = (v: string | null) => (v === null ? null : Number(v));

  return {
    skillName: skill.name,
    iterationNumber: iter.iterationNumber,
    withSkillMean: toNum(iter.withSkillPassRateMean),
    withSkillStddev: toNum(iter.withSkillPassRateStddev),
    withoutSkillMean: toNum(iter.withoutSkillPassRateMean),
    withoutSkillStddev: toNum(iter.withoutSkillPassRateStddev),
    withSkillTokensMean: iter.withSkillTokensMean,
    withSkillTimeSecondsMean: iter.withSkillTimeSecondsMean,
    withoutSkillTokensMean: iter.withoutSkillTokensMean,
    withoutSkillTimeSecondsMean: iter.withoutSkillTimeSecondsMean,
    runsPerConfiguration: iter.runsPerConfiguration,
    evalsCount: iter.evalsCount,
    notes: iter.notes,
    skillMdSnapshot: iter.skillMdSnapshot,
    gitCommitSha: iter.gitCommitSha,
    hostname: iter.hostname,
    uploadedAt: iter.uploadedAt,
    evalsDefinition: extractEvalsDefinition(iter.evalsDefinition),
    runs: runs.map((r) => ({
      id: r.id,
      evalId: r.evalId,
      evalName: r.evalName,
      configuration: r.configuration,
      runNumber: r.runNumber,
      passRate: toNum(r.passRate),
      passed: r.passed,
      total: r.total,
      timeSeconds: r.timeSeconds,
      tokens: r.tokens,
      toolCalls: r.toolCalls,
      errors: r.errors,
      notes: r.notes,
      expectations: extractExpectations(r.rawGrading),
    })),
  };
}

export type PerEvalPoint = {
  iterationNumber: number;
  withSkillMean: number | null;
  withoutSkillMean: number | null;
};

export type PerEvalTrajectory = {
  evalId: number;
  evalName: string | null;
  points: PerEvalPoint[];
};

export async function getSkillPerEvalTrajectory(
  name: string,
): Promise<PerEvalTrajectory[]> {
  const [skill] = await db
    .select()
    .from(schema.skills)
    .where(eq(schema.skills.name, name))
    .limit(1);
  if (!skill) return [];

  const rows = await db.execute<{
    iteration_number: number;
    eval_id: number;
    eval_name: string | null;
    configuration: "with_skill" | "without_skill";
    mean_pass_rate: string | null;
  }>(sql`
    SELECT
      i.iteration_number,
      r.eval_id,
      MAX(r.eval_name) AS eval_name,
      r.configuration,
      AVG(r.pass_rate::float)::text AS mean_pass_rate
    FROM ${schema.iterations} i
    JOIN ${schema.runs} r ON r.iteration_id = i.id
    WHERE i.skill_id = ${skill.id}
    GROUP BY i.iteration_number, r.eval_id, r.configuration
    ORDER BY r.eval_id, i.iteration_number
  `);

  const byEval = new Map<number, PerEvalTrajectory>();
  for (const row of rows) {
    if (!byEval.has(row.eval_id)) {
      byEval.set(row.eval_id, {
        evalId: row.eval_id,
        evalName: row.eval_name,
        points: [],
      });
    }
    const trajectory = byEval.get(row.eval_id)!;
    let point = trajectory.points.find(
      (p) => p.iterationNumber === row.iteration_number,
    );
    if (!point) {
      point = {
        iterationNumber: row.iteration_number,
        withSkillMean: null,
        withoutSkillMean: null,
      };
      trajectory.points.push(point);
    }
    const v = row.mean_pass_rate === null ? null : Number(row.mean_pass_rate);
    if (row.configuration === "with_skill") point.withSkillMean = v;
    else point.withoutSkillMean = v;
  }

  for (const t of byEval.values()) {
    t.points.sort((a, b) => a.iterationNumber - b.iterationNumber);
  }

  return [...byEval.values()].sort((a, b) => a.evalId - b.evalId);
}

export type EvalRunResult = {
  runNumber: number;
  passRate: number | null;
  passed: number | null;
  total: number | null;
  tokens: number | null;
  timeSeconds: number | null;
  toolCalls: number | null;
  errors: number | null;
  expectations: Expectation[];
};

export type EvalIterationResult = {
  iterationNumber: number;
  iterationId: number;
  uploadedAt: Date;
  gitCommitSha: string | null;
  withSkillRuns: EvalRunResult[];
  withoutSkillRuns: EvalRunResult[];
};

export type EvalTrajectoryPoint = {
  iterationNumber: number;
  withSkillMean: number | null;
  withoutSkillMean: number | null;
};

export type SkillEvalDetail = {
  skillName: string;
  evalId: number;
  evalName: string | null;
  definition: EvalDefinition | null;
  iterations: EvalIterationResult[];
  trajectory: EvalTrajectoryPoint[];
};

export async function getSkillEvalDetail(
  name: string,
  evalId: number,
): Promise<SkillEvalDetail | null> {
  const [skill] = await db
    .select()
    .from(schema.skills)
    .where(eq(schema.skills.name, name))
    .limit(1);
  if (!skill) return null;

  const rows = await db.execute<{
    iter_id: number;
    iteration_number: number;
    uploaded_at: Date;
    git_commit_sha: string | null;
    evals_definition: unknown;
    run_id: number;
    run_number: number;
    configuration: "with_skill" | "without_skill";
    pass_rate: string | null;
    passed: number | null;
    total: number | null;
    tokens: number | null;
    time_seconds: number | null;
    tool_calls: number | null;
    errors: number | null;
    eval_name: string | null;
    raw_grading: unknown;
  }>(sql`
    SELECT
      i.id AS iter_id,
      i.iteration_number,
      i.uploaded_at,
      i.git_commit_sha,
      i.evals_definition,
      r.id AS run_id,
      r.run_number,
      r.configuration,
      r.pass_rate,
      r.passed,
      r.total,
      r.tokens,
      r.time_seconds,
      r.tool_calls,
      r.errors,
      r.eval_name,
      r.raw_grading
    FROM ${schema.iterations} i
    JOIN ${schema.runs} r ON r.iteration_id = i.id
    WHERE i.skill_id = ${skill.id} AND r.eval_id = ${evalId}
    ORDER BY i.iteration_number ASC, r.configuration ASC, r.run_number ASC
  `);

  if (rows.length === 0) return null;

  const toNum = (v: string | null) => (v === null ? null : Number(v));

  const byIter = new Map<number, EvalIterationResult>();
  const definitionsByIter = new Map<number, EvalDefinition | null>();
  let evalName: string | null = null;

  for (const row of rows) {
    if (!byIter.has(row.iter_id)) {
      byIter.set(row.iter_id, {
        iterationNumber: row.iteration_number,
        iterationId: row.iter_id,
        uploadedAt: row.uploaded_at,
        gitCommitSha: row.git_commit_sha,
        withSkillRuns: [],
        withoutSkillRuns: [],
      });
      const defs = extractEvalsDefinition(row.evals_definition);
      const match = defs?.find((d) => d.id === evalId) ?? null;
      definitionsByIter.set(row.iter_id, match);
    }
    if (!evalName && row.eval_name) evalName = row.eval_name;

    const result: EvalRunResult = {
      runNumber: row.run_number,
      passRate: toNum(row.pass_rate),
      passed: row.passed,
      total: row.total,
      tokens: row.tokens,
      timeSeconds: row.time_seconds,
      toolCalls: row.tool_calls,
      errors: row.errors,
      expectations: extractExpectations(row.raw_grading),
    };
    const bucket = byIter.get(row.iter_id)!;
    if (row.configuration === "with_skill") bucket.withSkillRuns.push(result);
    else bucket.withoutSkillRuns.push(result);
  }

  const itersAsc = [...byIter.values()].sort(
    (a, b) => a.iterationNumber - b.iterationNumber,
  );

  // pick the latest non-null definition as the canonical task
  let definition: EvalDefinition | null = null;
  for (const it of [...itersAsc].reverse()) {
    const d = definitionsByIter.get(it.iterationId);
    if (d) {
      definition = d;
      break;
    }
  }

  const meanOf = (rs: EvalRunResult[]) => {
    const vals = rs
      .map((r) => r.passRate)
      .filter((v): v is number => v !== null);
    if (vals.length === 0) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };

  const trajectory: EvalTrajectoryPoint[] = itersAsc.map((it) => ({
    iterationNumber: it.iterationNumber,
    withSkillMean: meanOf(it.withSkillRuns),
    withoutSkillMean: meanOf(it.withoutSkillRuns),
  }));

  return {
    skillName: skill.name,
    evalId,
    evalName,
    definition,
    iterations: itersAsc.slice().reverse(), // newest first for display
    trajectory,
  };
}
