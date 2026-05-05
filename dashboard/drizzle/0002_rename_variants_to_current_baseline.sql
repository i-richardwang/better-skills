-- Switch from user-named variants to fixed current/baseline configs.
--
-- Schema change: primary_variant / baseline_variant / variants columns are
-- gone; baseline_variant becomes baseline_resolved (records what `baseline`
-- pointed to — "none", "iteration-N", "path:/abs"). The metric columns are
-- renamed primary_* → current_* in place; the underlying data survives.
--
-- Data: under the from-zero mandate, no compatibility for old-shape rows.
-- Any runs.configuration row that isn't 'current' or 'baseline' (the only
-- two values the new pipeline produces) gets dropped — the new dashboard
-- queries strict-filter on those literals, so leaving them around would
-- just be invisible orphan rows in the DB. Iteration rows whose runs are
-- all wiped are kept for their SKILL.md / benchmark snapshots; the metric
-- columns survived the rename so trajectory charts still work for them.

DELETE FROM "runs" WHERE "configuration" NOT IN ('current', 'baseline');

ALTER TABLE "iterations" DROP COLUMN "primary_variant";
ALTER TABLE "iterations" DROP COLUMN "variants";
ALTER TABLE "iterations" RENAME COLUMN "baseline_variant" TO "baseline_resolved";

ALTER TABLE "iterations" RENAME COLUMN "primary_pass_rate_mean" TO "current_pass_rate_mean";
ALTER TABLE "iterations" RENAME COLUMN "primary_pass_rate_stddev" TO "current_pass_rate_stddev";
ALTER TABLE "iterations" RENAME COLUMN "primary_tokens_mean" TO "current_tokens_mean";
ALTER TABLE "iterations" RENAME COLUMN "primary_time_seconds_mean" TO "current_time_seconds_mean";
