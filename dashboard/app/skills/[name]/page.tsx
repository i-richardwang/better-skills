import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getSkillTrajectory,
  getSkillPerEvalTrajectory,
} from "@/lib/queries";
import type { IterationPoint } from "@/lib/queries";
import {
  fmtDateTime,
  fmtDelta,
  fmtPct,
  fmtRelative,
  fmtSeconds,
  fmtTokens,
  shortSha,
} from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import {
  TrajectoryChartClient,
  type TrajectoryDatum,
} from "@/components/trajectory-chart-client";
import { PerEvalTrajectoryGridClient } from "@/components/per-eval-trajectory-client";
import {
  ResourceTrajectoryGridClient,
  type ResourceTrajectoryDatum,
} from "@/components/resource-trajectory-client";

export const dynamic = "force-dynamic";

export default async function SkillPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const [skill, perEval] = await Promise.all([
    getSkillTrajectory(name),
    getSkillPerEvalTrajectory(name),
  ]);
  if (!skill) notFound();

  const points = skill.points;
  const latest = points[points.length - 1] ?? null;
  const first = points[0] ?? null;
  const chartData: TrajectoryDatum[] = points.map((p) => ({
    iteration: p.iterationNumber,
    primary: p.primaryMean,
    primaryBandLow:
      p.primaryMean !== null && p.primaryStddev !== null
        ? Math.max(0, p.primaryMean - p.primaryStddev)
        : null,
    primaryBandHigh:
      p.primaryMean !== null && p.primaryStddev !== null
        ? Math.min(1, p.primaryMean + p.primaryStddev)
        : null,
    baseline: p.baselineMean,
    baselineBandLow:
      p.baselineMean !== null && p.baselineStddev !== null
        ? Math.max(0, p.baselineMean - p.baselineStddev)
        : null,
    baselineBandHigh:
      p.baselineMean !== null && p.baselineStddev !== null
        ? Math.min(1, p.baselineMean + p.baselineStddev)
        : null,
  }));

  const resourceData: ResourceTrajectoryDatum[] = points.map((p) => ({
    iteration: p.iterationNumber,
    primaryTokens: p.primaryTokensMean,
    baselineTokens: p.baselineTokensMean,
    primarySeconds: p.primaryTimeSecondsMean,
    baselineSeconds: p.baselineTimeSecondsMean,
  }));

  const hasResourceData = resourceData.some(
    (d) =>
      d.primaryTokens !== null ||
      d.baselineTokens !== null ||
      d.primarySeconds !== null ||
      d.baselineSeconds !== null,
  );

  // Variant labels — use the most-recent iteration's declared names so the
  // chart legend reflects what the user actually wrote in evals.json.
  const primaryLabel = latest?.primaryVariant ?? "primary";
  const baselineLabel = latest?.baselineVariant ?? "baseline";

  const latestDelta =
    latest && latest.primaryMean !== null && latest.baselineMean !== null
      ? latest.primaryMean - latest.baselineMean
      : null;

  const trendDelta =
    first && latest && first.primaryMean !== null && latest.primaryMean !== null
      ? latest.primaryMean - first.primaryMean
      : null;

  return (
    <div className="space-y-10">
      <SkillHeader
        name={skill.name}
        createdAt={skill.createdAt}
        updatedAt={skill.updatedAt}
        iterationCount={points.length}
      />

      <KpiRow
        latestPassRate={latest?.primaryMean ?? null}
        latestDelta={latestDelta}
        trendDelta={trendDelta}
        latestIteration={latest?.iterationNumber ?? null}
        primaryLabel={primaryLabel}
        baselineLabel={baselineLabel}
      />

      <section className="space-y-4">
        <header className="border-border flex items-baseline justify-between border-b pb-3">
          <h2 className="font-heading text-xl tracking-tight">
            Pass-rate trajectory
          </h2>
          <LegendHint primaryLabel={primaryLabel} baselineLabel={baselineLabel} />
        </header>
        <Card>
          <CardContent className="px-2 py-2">
            {points.length === 0 ? (
              <EmptyChart />
            ) : (
              <TrajectoryChartClient
                data={chartData}
                primaryLabel={primaryLabel}
                baselineLabel={baselineLabel}
              />
            )}
          </CardContent>
        </Card>
      </section>

      {perEval.length > 0 ? (
        <section className="space-y-4">
          <header className="border-border flex items-baseline justify-between border-b pb-3">
            <h2 className="font-heading text-xl tracking-tight">
              Per-eval trajectories
            </h2>
            <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
              {perEval.length} eval{perEval.length === 1 ? "" : "s"} · click for
              task detail
            </span>
          </header>
          <PerEvalTrajectoryGridClient items={perEval} skillName={skill.name} />
        </section>
      ) : null}

      {hasResourceData ? (
        <section className="space-y-4">
          <header className="border-border flex items-baseline justify-between border-b pb-3">
            <h2 className="font-heading text-xl tracking-tight">
              Resource trajectory
            </h2>
            <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
              tokens · time per run
            </span>
          </header>
          <ResourceTrajectoryGridClient
            data={resourceData}
            primaryLabel={primaryLabel}
            baselineLabel={baselineLabel}
          />
        </section>
      ) : null}

      <section className="space-y-4">
        <header className="border-border flex items-baseline justify-between border-b pb-3">
          <h2 className="font-heading text-xl tracking-tight">Iterations</h2>
          <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
            {points.length} recorded
          </span>
        </header>
        <IterationsTable name={skill.name} points={points} />
      </section>
    </div>
  );
}

function SkillHeader({
  name,
  createdAt,
  updatedAt,
  iterationCount,
}: {
  name: string;
  createdAt: Date;
  updatedAt: Date;
  iterationCount: number;
}) {
  return (
    <section className="space-y-4">
      <nav className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
        <Link href="/" className="hover:text-foreground">
          Portfolio
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">{name}</span>
      </nav>
      <h1 className="font-heading text-4xl leading-[1.05] tracking-tight md:text-5xl">
        {name}
      </h1>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-[10px] tracking-widest uppercase">
        <span>{iterationCount} iterations</span>
        <span>first seen {fmtRelative(createdAt)}</span>
        <span>updated {fmtRelative(updatedAt)}</span>
      </div>
    </section>
  );
}

function KpiRow({
  latestPassRate,
  latestDelta,
  trendDelta,
  latestIteration,
  primaryLabel,
  baselineLabel,
}: {
  latestPassRate: number | null;
  latestDelta: number | null;
  trendDelta: number | null;
  latestIteration: number | null;
  primaryLabel: string;
  baselineLabel: string;
}) {
  return (
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi
        label={`Latest ${primaryLabel}`}
        value={fmtPct(latestPassRate, 1)}
        hint={latestIteration !== null ? `iteration #${latestIteration}` : "—"}
      />
      <Kpi
        label={`Latest vs. ${baselineLabel}`}
        value={fmtDelta(latestDelta)}
        tone={
          latestDelta === null
            ? "secondary"
            : latestDelta > 0
              ? "positive"
              : latestDelta < 0
                ? "destructive"
                : "secondary"
        }
        hint="pass-rate delta this iteration"
      />
      <Kpi
        label="Change since first"
        value={fmtDelta(trendDelta)}
        tone={
          trendDelta === null
            ? "secondary"
            : trendDelta > 0
              ? "positive"
              : trendDelta < 0
                ? "destructive"
                : "secondary"
        }
        hint={`${primaryLabel} lifetime movement`}
      />
      <Kpi
        label="Runs per config"
        value={
          latestIteration !== null ? `#${latestIteration}` : "—"
        }
        hint="see detail for breakdown"
      />
    </section>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone = "secondary",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "secondary" | "positive" | "destructive";
}) {
  const valueColor =
    tone === "positive"
      ? "text-emerald-600 dark:text-emerald-300"
      : tone === "destructive"
        ? "text-destructive"
        : "";
  return (
    <Card>
      <CardContent>
        <div className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
          {label}
        </div>
        <div
          className={`font-mono mt-1 text-3xl font-medium tabular-nums ${valueColor}`}
        >
          {value}
        </div>
        {hint ? (
          <div className="text-muted-foreground mt-1 text-xs">{hint}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LegendHint({
  primaryLabel,
  baselineLabel,
}: {
  primaryLabel: string;
  baselineLabel: string;
}) {
  return (
    <div className="flex items-center gap-4 font-mono text-[10px] tracking-widest uppercase">
      <LegendDot color="oklch(0.62 0.14 150)" label={primaryLabel} solid />
      <LegendDot color="oklch(0.60 0.11 55)" label={baselineLabel} />
    </div>
  );
}

function LegendDot({
  color,
  label,
  solid = false,
}: {
  color: string;
  label: string;
  solid?: boolean;
}) {
  return (
    <span className="text-muted-foreground flex items-center gap-1.5">
      <span
        aria-hidden
        className={`inline-block h-[2px] w-5`}
        style={{
          background: solid
            ? color
            : `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)`,
        }}
      />
      {label}
    </span>
  );
}

function EmptyChart() {
  return (
    <div className="text-muted-foreground flex h-80 items-center justify-center font-mono text-[10px] tracking-widest uppercase">
      No iterations recorded
    </div>
  );
}

function IterationsTable({
  name,
  points,
}: {
  name: string;
  points: IterationPoint[];
}) {
  if (points.length === 0) {
    return (
      <Card>
        <CardContent className="text-muted-foreground text-center text-sm">
          No iterations yet.
        </CardContent>
      </Card>
    );
  }

  const sorted = [...points].sort(
    (a, b) => b.iterationNumber - a.iterationNumber,
  );

  return (
    <Card>
      <Table>
        <TableHeader>
          <tr>
            <TableHead>Iter</TableHead>
            <TableHead>Primary</TableHead>
            <TableHead>Baseline</TableHead>
            <TableHead>Δ</TableHead>
            <TableHead>Tokens (primary)</TableHead>
            <TableHead>Time (primary)</TableHead>
            <TableHead>Commit</TableHead>
            <TableHead>Uploaded</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {sorted.map((p) => {
            const delta =
              p.primaryMean !== null && p.baselineMean !== null
                ? p.primaryMean - p.baselineMean
                : null;
            const href = `/skills/${encodeURIComponent(name)}/iterations/${p.iterationNumber}`;
            return (
              <TableRow key={p.iterationNumber} data-interactive="true">
                <TableCell>
                  <Link
                    href={href}
                    className="font-mono font-medium tabular-nums hover:underline"
                  >
                    #{p.iterationNumber}
                  </Link>
                </TableCell>
                <TableCell className="font-mono tabular-nums">
                  <div className="flex items-baseline gap-1.5">
                    <span>{fmtPct(p.primaryMean, 1)}</span>
                    {p.primaryStddev !== null ? (
                      <span className="text-muted-foreground text-[10px]">
                        ±{(p.primaryStddev * 100).toFixed(1)}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="font-mono tabular-nums">
                  <div className="flex items-baseline gap-1.5">
                    <span>{fmtPct(p.baselineMean, 1)}</span>
                    {p.baselineStddev !== null ? (
                      <span className="text-muted-foreground text-[10px]">
                        ±{(p.baselineStddev * 100).toFixed(1)}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  {delta === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <Badge
                      variant={
                        delta > 0
                          ? "positive"
                          : delta < 0
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {fmtDelta(delta)}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground font-mono tabular-nums">
                  {fmtTokens(p.primaryTokensMean)}
                </TableCell>
                <TableCell className="text-muted-foreground font-mono tabular-nums">
                  {fmtSeconds(p.primaryTimeSecondsMean)}
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">
                  {shortSha(p.gitCommitSha)}
                </TableCell>
                <TableCell
                  className="text-muted-foreground text-xs"
                  title={fmtDateTime(p.uploadedAt)}
                >
                  {fmtRelative(p.uploadedAt)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
