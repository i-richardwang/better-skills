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

// Each iteration runs two configs: `current` (the live skill) vs `baseline`
// (resolved from evals.json default_baseline). `baselineResolved` records
// what baseline pointed to (e.g. "iteration-1", "none", "path:/abs/...").

export type IterationPoint = {
  iterationNumber: number;
  baselineResolved: string | null;
  currentMean: number | null;
  currentStddev: number | null;
  baselineMean: number | null;
  baselineStddev: number | null;
  currentTokensMean: number | null;
  currentTimeSecondsMean: number | null;
  baselineTokensMean: number | null;
  baselineTimeSecondsMean: number | null;
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
      baselineResolved: it.baselineResolved,
      currentMean: toNum(it.currentPassRateMean),
      currentStddev: toNum(it.currentPassRateStddev),
      baselineMean: toNum(it.baselinePassRateMean),
      baselineStddev: toNum(it.baselinePassRateStddev),
      currentTokensMean: it.currentTokensMean,
      currentTimeSecondsMean: it.currentTimeSecondsMean,
      baselineTokensMean: it.baselineTokensMean,
      baselineTimeSecondsMean: it.baselineTimeSecondsMean,
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

// Per-case prompt snapshot the runner captured at plan time. Carries the
// resolved (concatenated) prompt the executor saw plus the template/file
// path+content breakdown — enough for the dashboard to diff prompt evolution
// across iterations without needing the original evals.json on disk.
export type EvalMetadataEntry = {
  evalId: number;
  evalName: string | null;
  prompt: string;
  promptTemplatePath: string | null;
  promptTemplateContent: string | null;
  promptFilePath: string | null;
  promptFileContent: string | null;
};

function extractEvalMetadata(raw: unknown): EvalMetadataEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: EvalMetadataEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const o = e as {
      eval_id?: unknown;
      eval_name?: unknown;
      prompt?: unknown;
      prompt_template_path?: unknown;
      prompt_template_content?: unknown;
      prompt_file_path?: unknown;
      prompt_file_content?: unknown;
    };
    if (typeof o.eval_id !== "number") continue;
    if (typeof o.prompt !== "string") continue;
    out.push({
      evalId: o.eval_id,
      evalName: typeof o.eval_name === "string" ? o.eval_name : null,
      prompt: o.prompt,
      promptTemplatePath:
        typeof o.prompt_template_path === "string" ? o.prompt_template_path : null,
      promptTemplateContent:
        typeof o.prompt_template_content === "string"
          ? o.prompt_template_content
          : null,
      promptFilePath:
        typeof o.prompt_file_path === "string" ? o.prompt_file_path : null,
      promptFileContent:
        typeof o.prompt_file_content === "string" ? o.prompt_file_content : null,
    });
  }
  return out.length > 0 ? out : null;
}

function extractEvalsDefinition(raw: unknown): EvalDefinition[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const cases = (raw as { cases?: unknown }).cases;
  if (!Array.isArray(cases) || cases.length === 0) return null;

  const out: EvalDefinition[] = [];
  for (const e of cases) {
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
  configuration: string;
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
  baselineResolved: string | null;
  currentMean: number | null;
  currentStddev: number | null;
  baselineMean: number | null;
  baselineStddev: number | null;
  currentTokensMean: number | null;
  currentTimeSecondsMean: number | null;
  baselineTokensMean: number | null;
  baselineTimeSecondsMean: number | null;
  runsPerConfiguration: number | null;
  evalsCount: number | null;
  notes: string[] | null;
  skillMdSnapshot: string | null;
  skillFiles: Record<string, string> | null;
  previousIterationNumber: number | null;
  previousSkillMdSnapshot: string | null;
  previousSkillFiles: Record<string, string> | null;
  gitCommitSha: string | null;
  hostname: string | null;
  uploadedAt: Date;
  evalsDefinition: EvalDefinition[] | null;
  evalMetadata: EvalMetadataEntry[] | null;
  previousEvalMetadata: EvalMetadataEntry[] | null;
  runs: RunRow[];
};

function asSkillFiles(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const val of Object.values(o)) {
    if (typeof val !== "string") return null;
  }
  return o as Record<string, string>;
}

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

  const [prev] = await db
    .select({
      iterationNumber: schema.iterations.iterationNumber,
      skillMdSnapshot: schema.iterations.skillMdSnapshot,
      skillFiles: schema.iterations.skillFiles,
      evalMetadata: schema.iterations.evalMetadata,
    })
    .from(schema.iterations)
    .where(
      and(
        eq(schema.iterations.skillId, skill.id),
        sql`${schema.iterations.iterationNumber} < ${iterationNumber}`,
      ),
    )
    .orderBy(desc(schema.iterations.iterationNumber))
    .limit(1);

  const toNum = (v: string | null) => (v === null ? null : Number(v));

  return {
    skillName: skill.name,
    iterationNumber: iter.iterationNumber,
    baselineResolved: iter.baselineResolved,
    currentMean: toNum(iter.currentPassRateMean),
    currentStddev: toNum(iter.currentPassRateStddev),
    baselineMean: toNum(iter.baselinePassRateMean),
    baselineStddev: toNum(iter.baselinePassRateStddev),
    currentTokensMean: iter.currentTokensMean,
    currentTimeSecondsMean: iter.currentTimeSecondsMean,
    baselineTokensMean: iter.baselineTokensMean,
    baselineTimeSecondsMean: iter.baselineTimeSecondsMean,
    runsPerConfiguration: iter.runsPerConfiguration,
    evalsCount: iter.evalsCount,
    notes: iter.notes,
    skillMdSnapshot: iter.skillMdSnapshot,
    skillFiles: asSkillFiles(iter.skillFiles),
    previousIterationNumber: prev?.iterationNumber ?? null,
    previousSkillMdSnapshot: prev?.skillMdSnapshot ?? null,
    previousSkillFiles: asSkillFiles(prev?.skillFiles),
    gitCommitSha: iter.gitCommitSha,
    hostname: iter.hostname,
    uploadedAt: iter.uploadedAt,
    evalsDefinition: extractEvalsDefinition(iter.evalsDefinition),
    evalMetadata: extractEvalMetadata(iter.evalMetadata),
    previousEvalMetadata: extractEvalMetadata(prev?.evalMetadata),
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

export type SkillCurrentSource = {
  iterationNumber: number;
  skillMdSnapshot: string | null;
  skillFiles: Record<string, string> | null;
};

export async function getSkillCurrentSource(
  name: string,
): Promise<SkillCurrentSource | null> {
  const [skill] = await db
    .select()
    .from(schema.skills)
    .where(eq(schema.skills.name, name))
    .limit(1);
  if (!skill) return null;

  const [iter] = await db
    .select({
      iterationNumber: schema.iterations.iterationNumber,
      skillMdSnapshot: schema.iterations.skillMdSnapshot,
      skillFiles: schema.iterations.skillFiles,
    })
    .from(schema.iterations)
    .where(eq(schema.iterations.skillId, skill.id))
    .orderBy(desc(schema.iterations.iterationNumber))
    .limit(1);
  if (!iter) return null;

  return {
    iterationNumber: iter.iterationNumber,
    skillMdSnapshot: iter.skillMdSnapshot,
    skillFiles: asSkillFiles(iter.skillFiles),
  };
}

export type PerEvalPoint = {
  iterationNumber: number;
  currentMean: number | null;
  baselineMean: number | null;
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

  // Configurations are fixed strings ("current"/"baseline") so the SQL
  // collapses to direct equality — no per-iteration variant lookup needed.
  const rows = await db.execute<{
    iteration_number: number;
    eval_id: number;
    eval_name: string | null;
    role: "current" | "baseline";
    mean_pass_rate: string | null;
  }>(sql`
    SELECT
      i.iteration_number,
      r.eval_id,
      MAX(r.eval_name) AS eval_name,
      r.configuration AS role,
      AVG(r.pass_rate)::text AS mean_pass_rate
    FROM ${schema.iterations} i
    JOIN ${schema.runs} r ON r.iteration_id = i.id
    WHERE i.skill_id = ${skill.id}
      AND r.configuration IN ('current', 'baseline')
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
        currentMean: null,
        baselineMean: null,
      };
      trajectory.points.push(point);
    }
    const v = row.mean_pass_rate === null ? null : Number(row.mean_pass_rate);
    if (row.role === "current") point.currentMean = v;
    else if (row.role === "baseline") point.baselineMean = v;
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
  baselineResolved: string | null;
  currentRuns: EvalRunResult[];
  baselineRuns: EvalRunResult[];
  // The runner-captured prompt snapshot for THIS case in THIS iteration
  // (template path/content + body path/content + resolved prompt). Null when
  // the iteration predates eval_metadata capture or the case wasn't run.
  evalMetadata: EvalMetadataEntry | null;
};

export type EvalTrajectoryPoint = {
  iterationNumber: number;
  currentMean: number | null;
  baselineMean: number | null;
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
    baseline_resolved: string | null;
    evals_definition: unknown;
    eval_metadata: unknown;
    run_id: number;
    run_number: number;
    configuration: string;
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
      i.baseline_resolved,
      i.evals_definition,
      i.eval_metadata,
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
      const meta = extractEvalMetadata(row.eval_metadata);
      const matchMeta = meta?.find((m) => m.evalId === evalId) ?? null;
      byIter.set(row.iter_id, {
        iterationNumber: row.iteration_number,
        iterationId: row.iter_id,
        uploadedAt: row.uploaded_at,
        gitCommitSha: row.git_commit_sha,
        baselineResolved: row.baseline_resolved,
        currentRuns: [],
        baselineRuns: [],
        evalMetadata: matchMeta,
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
    if (row.configuration === "current") bucket.currentRuns.push(result);
    else if (row.configuration === "baseline") bucket.baselineRuns.push(result);
  }

  const itersAsc = [...byIter.values()].sort(
    (a, b) => a.iterationNumber - b.iterationNumber,
  );

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
    currentMean: meanOf(it.currentRuns),
    baselineMean: meanOf(it.baselineRuns),
  }));

  return {
    skillName: skill.name,
    evalId,
    evalName,
    definition,
    iterations: itersAsc.slice().reverse(),
    trajectory,
  };
}
