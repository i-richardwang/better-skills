import { NextResponse } from "next/server";
import { count, desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await db
      .select({
        name: schema.skills.name,
        latest_iteration_number: schema.skills.latestIterationNumber,
        latest_pass_rate: schema.skills.latestPassRate,
        created_at: schema.skills.createdAt,
        updated_at: schema.skills.updatedAt,
        iterations_count: count(schema.iterations.id),
      })
      .from(schema.skills)
      .leftJoin(schema.iterations, eq(schema.iterations.skillId, schema.skills.id))
      .groupBy(schema.skills.id)
      .orderBy(desc(schema.skills.updatedAt));

    return NextResponse.json({ skills: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Query failed", detail: message },
      { status: 500 },
    );
  }
}
