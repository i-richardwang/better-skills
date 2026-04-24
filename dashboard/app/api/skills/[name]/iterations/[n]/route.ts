import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string; n: string }> },
) {
  const { name, n } = await params;
  const iterationNumber = Number.parseInt(n, 10);

  if (!Number.isFinite(iterationNumber) || iterationNumber < 0) {
    return NextResponse.json(
      { error: "Invalid iteration number" },
      { status: 400 },
    );
  }

  try {
    const skill = await db.query.skills.findFirst({
      where: eq(schema.skills.name, name),
    });
    if (!skill) {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }

    const iteration = await db.query.iterations.findFirst({
      where: and(
        eq(schema.iterations.skillId, skill.id),
        eq(schema.iterations.iterationNumber, iterationNumber),
      ),
    });

    if (!iteration) {
      return NextResponse.json(
        { error: "Iteration not found" },
        { status: 404 },
      );
    }

    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.iterationId, iteration.id))
      .orderBy(
        asc(schema.runs.evalId),
        asc(schema.runs.configuration),
        asc(schema.runs.runNumber),
      );

    return NextResponse.json({
      skill: {
        name: skill.name,
      },
      iteration,
      runs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Query failed", detail: message },
      { status: 500 },
    );
  }
}
