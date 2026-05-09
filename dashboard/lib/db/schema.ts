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

// Each iteration runs exactly two configs — `current` (the live skill) and
// `baseline` (resolved from evals.json `default_baseline` or the --baseline
// CLI flag). The literal strings live in `runs.configuration`.

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

    // Records what `current` was compared against in this iteration. Values
    // mirror the baseline grammar: "none" | "iteration-N" | "path:/abs". Null
    // when the upload predates the baseline_resolved field.
    baselineResolved: text("baseline_resolved"),

    // Aggregated metrics for current vs baseline. Charts and top-level KPIs
    // read from here.
    currentPassRateMean: numeric("current_pass_rate_mean", { precision: 5, scale: 4 }),
    currentPassRateStddev: numeric("current_pass_rate_stddev", { precision: 5, scale: 4 }),
    baselinePassRateMean: numeric("baseline_pass_rate_mean", { precision: 5, scale: 4 }),
    baselinePassRateStddev: numeric("baseline_pass_rate_stddev", { precision: 5, scale: 4 }),
    currentTokensMean: real("current_tokens_mean"),
    currentTimeSecondsMean: real("current_time_seconds_mean"),
    baselineTokensMean: real("baseline_tokens_mean"),
    baselineTimeSecondsMean: real("baseline_time_seconds_mean"),

    runsPerConfiguration: integer("runs_per_configuration"),
    evalsCount: integer("evals_count"),

    // Resolved at plan time by the runner and lifted from manifest.json on
    // upload. Captures what actually ran (executor + model + grader). Null on
    // iterations uploaded before the runner tracked these fields.
    executor: text("executor"),
    executorModel: text("executor_model"),
    graderExecutor: text("grader_executor"),
    graderModel: text("grader_model"),

    notes: text("notes").array(),
    skillMdSnapshot: text("skill_md_snapshot"),
    gitCommitSha: text("git_commit_sha"),
    hostname: text("hostname"),

    rawBenchmark: jsonb("raw_benchmark").notNull(),
    evalsDefinition: jsonb("evals_definition"),
    // Map of {relative_path: file_contents} for the rest of the skill dir
    // (excludes SKILL.md and evals.json — those have dedicated columns).
    skillFiles: jsonb("skill_files"),
    // Per-case metadata array as the runner saw it at plan time. Each entry
    // is the eval_metadata.json for one case: eval_id, eval_name, the
    // resolved (concatenated) prompt, plus the prompt_template/prompt_file
    // path+content pieces. Lets the dashboard diff the exact prompt content
    // — including any project-level template referenced by prompt_template
    // even when the file lives outside the evals directory.
    evalMetadata: jsonb("eval_metadata"),

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
    // Always one of "current" | "baseline". Stored as plain text rather than
    // an enum so a future schema change (e.g. extra comparison branches)
    // doesn't require a column-type migration.
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
