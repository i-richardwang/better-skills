import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  real,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// Variant names are user-chosen (declared in evals.json) — stored as plain text
// instead of a pgEnum so any naming scheme works.

export const skills = pgTable(
  "skills",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    latestIterationNumber: integer("latest_iteration_number"),
    latestPassRate: numeric("latest_pass_rate", { precision: 5, scale: 4 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex("skills_name_key").on(t.name)],
);

export const iterations = pgTable(
  "iterations",
  {
    id: serial("id").primaryKey(),
    skillId: integer("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    iterationNumber: integer("iteration_number").notNull(),

    // Variant declarations for this iteration (from evals.json defaults).
    primaryVariant: text("primary_variant"),
    baselineVariant: text("baseline_variant"),
    variants: text("variants").array(),

    // Aggregated metrics for the primary / baseline variants. Charts and
    // top-level KPIs read from here.
    primaryPassRateMean: numeric("primary_pass_rate_mean", { precision: 5, scale: 4 }),
    primaryPassRateStddev: numeric("primary_pass_rate_stddev", { precision: 5, scale: 4 }),
    baselinePassRateMean: numeric("baseline_pass_rate_mean", { precision: 5, scale: 4 }),
    baselinePassRateStddev: numeric("baseline_pass_rate_stddev", { precision: 5, scale: 4 }),
    primaryTokensMean: real("primary_tokens_mean"),
    primaryTimeSecondsMean: real("primary_time_seconds_mean"),
    baselineTokensMean: real("baseline_tokens_mean"),
    baselineTimeSecondsMean: real("baseline_time_seconds_mean"),

    runsPerConfiguration: integer("runs_per_configuration"),
    evalsCount: integer("evals_count"),

    notes: text("notes").array(),
    skillMdSnapshot: text("skill_md_snapshot"),
    gitCommitSha: text("git_commit_sha"),
    hostname: text("hostname"),

    rawBenchmark: jsonb("raw_benchmark").notNull(),
    evalsDefinition: jsonb("evals_definition"),

    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("iterations_skill_iter_key").on(t.skillId, t.iterationNumber),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: serial("id").primaryKey(),
    iterationId: integer("iteration_id")
      .notNull()
      .references(() => iterations.id, { onDelete: "cascade" }),
    evalId: integer("eval_id").notNull(),
    evalName: text("eval_name"),
    // Variant name as declared in evals.json — free text, no enum.
    configuration: text("configuration").notNull(),
    runNumber: integer("run_number").notNull(),

    passRate: numeric("pass_rate", { precision: 5, scale: 4 }),
    passed: integer("passed"),
    total: integer("total"),
    timeSeconds: real("time_seconds"),
    tokens: integer("tokens"),
    toolCalls: integer("tool_calls"),
    errors: integer("errors"),

    notes: text("notes").array(),
    rawGrading: jsonb("raw_grading"),
  },
  (t) => [
    uniqueIndex("runs_unique_key").on(
      t.iterationId,
      t.evalId,
      t.configuration,
      t.runNumber,
    ),
  ],
);

export const skillsRelations = relations(skills, ({ many }) => ({
  iterations: many(iterations),
}));

export const iterationsRelations = relations(iterations, ({ one, many }) => ({
  skill: one(skills, {
    fields: [iterations.skillId],
    references: [skills.id],
  }),
  runs: many(runs),
}));

export const runsRelations = relations(runs, ({ one }) => ({
  iteration: one(iterations, {
    fields: [runs.iterationId],
    references: [iterations.id],
  }),
}));

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
export type Iteration = typeof iterations.$inferSelect;
export type NewIteration = typeof iterations.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
