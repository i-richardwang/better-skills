import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Returns the highest iteration_number recorded for a skill so the CLI can
// pick the next iteration safely on a fresh device — without that signal,
// `iterate` defaults to 1 and the upsert silently overwrites the historical
// iteration 1. Returns null when the skill exists but has no iterations
// (impossible today since uploads create both rows in one transaction, but
// guarded for completeness). 404 when the skill itself is unknown.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;

  const skill = await db.query.skills.findFirst({
    where: eq(schema.skills.name, name),
    columns: { id: true, latestIterationNumber: true },
  });

  if (!skill) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }

  return NextResponse.json({
    skill_name: name,
    latest_iteration_number: skill.latestIterationNumber,
  });
}
