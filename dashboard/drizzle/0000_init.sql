CREATE TABLE "iterations" (
	"id" serial PRIMARY KEY NOT NULL,
	"skill_id" integer NOT NULL,
	"iteration_number" integer NOT NULL,
	"baseline_resolved" text,
	"current_pass_rate_mean" numeric(5, 4),
	"current_pass_rate_stddev" numeric(5, 4),
	"baseline_pass_rate_mean" numeric(5, 4),
	"baseline_pass_rate_stddev" numeric(5, 4),
	"current_tokens_mean" real,
	"current_time_seconds_mean" real,
	"baseline_tokens_mean" real,
	"baseline_time_seconds_mean" real,
	"runs_per_configuration" integer,
	"evals_count" integer,
	"notes" text[],
	"skill_md_snapshot" text,
	"git_commit_sha" text,
	"hostname" text,
	"raw_benchmark" jsonb NOT NULL,
	"evals_definition" jsonb,
	"skill_files" jsonb,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"iteration_id" integer NOT NULL,
	"eval_id" integer NOT NULL,
	"eval_name" text,
	"configuration" text NOT NULL,
	"run_number" integer NOT NULL,
	"pass_rate" numeric(5, 4),
	"passed" integer,
	"total" integer,
	"time_seconds" real,
	"tokens" integer,
	"tool_calls" integer,
	"errors" integer,
	"notes" text[],
	"raw_grading" jsonb
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"latest_iteration_number" integer,
	"latest_pass_rate" numeric(5, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "iterations" ADD CONSTRAINT "iterations_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_iteration_id_iterations_id_fk" FOREIGN KEY ("iteration_id") REFERENCES "public"."iterations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "iterations_skill_iter_key" ON "iterations" USING btree ("skill_id","iteration_number");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_unique_key" ON "runs" USING btree ("iteration_id","eval_id","configuration","run_number");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_name_key" ON "skills" USING btree ("name");