import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;

  try {
    const skill = await db.query.skills.findFirst({
      where: eq(schema.skills.name, name),
    });

    if (!skill) {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }

    const iterations = await db
      .select({
        id: schema.iterations.id,
        iteration_number: schema.iterations.iterationNumber,
        with_skill_pass_rate_mean: schema.iterations.withSkillPassRateMean,
        with_skill_pass_rate_stddev: schema.iterations.withSkillPassRateStddev,
        without_skill_pass_rate_mean: schema.iterations.withoutSkillPassRateMean,
        without_skill_pass_rate_stddev:
          schema.iterations.withoutSkillPassRateStddev,
        with_skill_tokens_mean: schema.iterations.withSkillTokensMean,
        with_skill_time_seconds_mean: schema.iterations.withSkillTimeSecondsMean,
        without_skill_tokens_mean: schema.iterations.withoutSkillTokensMean,
        without_skill_time_seconds_mean:
          schema.iterations.withoutSkillTimeSecondsMean,
        runs_per_configuration: schema.iterations.runsPerConfiguration,
        evals_count: schema.iterations.evalsCount,
        notes: schema.iterations.notes,
        git_commit_sha: schema.iterations.gitCommitSha,
        hostname: schema.iterations.hostname,
        uploaded_at: schema.iterations.uploadedAt,
      })
      .from(schema.iterations)
      .where(eq(schema.iterations.skillId, skill.id))
      .orderBy(asc(schema.iterations.iterationNumber));

    return NextResponse.json({
      skill: {
        name: skill.name,
        latest_iteration_number: skill.latestIterationNumber,
        latest_pass_rate: skill.latestPassRate,
        created_at: skill.createdAt,
        updated_at: skill.updatedAt,
      },
      iterations,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Query failed", detail: message },
      { status: 500 },
    );
  }
}
