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
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui/table";
import {
  TrajectoryChartClient,
  type TrajectoryDatum,
} from "@/components/trajectory-chart-client";
import { PerEvalTrajectoryGridClient } from "@/components/per-eval-trajectory-client";

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
    withSkill: p.withSkillMean,
    withSkillBandLow:
      p.withSkillMean !== null && p.withSkillStddev !== null
        ? Math.max(0, p.withSkillMean - p.withSkillStddev)
        : null,
    withSkillBandHigh:
      p.withSkillMean !== null && p.withSkillStddev !== null
        ? Math.min(1, p.withSkillMean + p.withSkillStddev)
        : null,
    withoutSkill: p.withoutSkillMean,
    withoutSkillBandLow:
      p.withoutSkillMean !== null && p.withoutSkillStddev !== null
        ? Math.max(0, p.withoutSkillMean - p.withoutSkillStddev)
        : null,
    withoutSkillBandHigh:
      p.withoutSkillMean !== null && p.withoutSkillStddev !== null
        ? Math.min(1, p.withoutSkillMean + p.withoutSkillStddev)
        : null,
  }));

  const latestDelta =
    latest && latest.withSkillMean !== null && latest.withoutSkillMean !== null
      ? latest.withSkillMean - latest.withoutSkillMean
      : null;

  const trendDelta =
    first && latest && first.withSkillMean !== null && latest.withSkillMean !== null
      ? latest.withSkillMean - first.withSkillMean
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
        latestPassRate={latest?.withSkillMean ?? null}
        latestDelta={latestDelta}
        trendDelta={trendDelta}
        latestIteration={latest?.iterationNumber ?? null}
      />

      <section className="space-y-4">
        <header className="border-border flex items-baseline justify-between border-b pb-3">
          <h2 className="font-heading text-xl tracking-tight">
            Pass-rate trajectory
          </h2>
          <LegendHint />
        </header>
        <Card>
          <CardBody className="px-2 py-2">
            {points.length === 0 ? (
              <EmptyChart />
            ) : (
              <TrajectoryChartClient data={chartData} />
            )}
          </CardBody>
        </Card>
      </section>

      {perEval.length > 0 ? (
        <section className="space-y-4">
          <header className="border-border flex items-baseline justify-between border-b pb-3">
            <h2 className="font-heading text-xl tracking-tight">
              Per-eval trajectories
            </h2>
            <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
              {perEval.length} eval{perEval.length === 1 ? "" : "s"} · mean
              pass rate per configuration
            </span>
          </header>
          <PerEvalTrajectoryGridClient items={perEval} />
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
}: {
  latestPassRate: number | null;
  latestDelta: number | null;
  trendDelta: number | null;
  latestIteration: number | null;
}) {
  return (
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi
        label="Latest with_skill"
        value={fmtPct(latestPassRate, 1)}
        hint={latestIteration !== null ? `iteration #${latestIteration}` : "—"}
      />
      <Kpi
        label="Latest vs. without"
        value={fmtDelta(latestDelta)}
        tone={
          latestDelta === null
            ? "muted"
            : latestDelta > 0
              ? "positive"
              : latestDelta < 0
                ? "negative"
                : "muted"
        }
        hint="pass-rate delta this iteration"
      />
      <Kpi
        label="Change since first"
        value={fmtDelta(trendDelta)}
        tone={
          trendDelta === null
            ? "muted"
            : trendDelta > 0
              ? "positive"
              : trendDelta < 0
                ? "negative"
                : "muted"
        }
        hint="with_skill lifetime movement"
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
  tone = "muted",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "muted" | "positive" | "negative";
}) {
  const valueColor =
    tone === "positive"
      ? "text-emerald-600 dark:text-emerald-300"
      : tone === "negative"
        ? "text-destructive"
        : "";
  return (
    <Card>
      <CardBody>
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
      </CardBody>
    </Card>
  );
}

function LegendHint() {
  return (
    <div className="flex items-center gap-4 font-mono text-[10px] tracking-widest uppercase">
      <LegendDot color="oklch(0.62 0.14 150)" label="with_skill" solid />
      <LegendDot color="oklch(0.60 0.11 55)" label="without_skill" />
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
        <CardBody className="text-muted-foreground text-center text-sm">
          No iterations yet.
        </CardBody>
      </Card>
    );
  }

  const sorted = [...points].sort(
    (a, b) => b.iterationNumber - a.iterationNumber,
  );

  return (
    <Card>
      <Table>
        <TableHead>
          <tr>
            <TableHeaderCell>Iter</TableHeaderCell>
            <TableHeaderCell>With skill</TableHeaderCell>
            <TableHeaderCell>Without skill</TableHeaderCell>
            <TableHeaderCell>Δ</TableHeaderCell>
            <TableHeaderCell>Tokens (w/)</TableHeaderCell>
            <TableHeaderCell>Time (w/)</TableHeaderCell>
            <TableHeaderCell>Commit</TableHeaderCell>
            <TableHeaderCell>Uploaded</TableHeaderCell>
          </tr>
        </TableHead>
        <TableBody>
          {sorted.map((p) => {
            const delta =
              p.withSkillMean !== null && p.withoutSkillMean !== null
                ? p.withSkillMean - p.withoutSkillMean
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
                    <span>{fmtPct(p.withSkillMean, 1)}</span>
                    {p.withSkillStddev !== null ? (
                      <span className="text-muted-foreground text-[10px]">
                        ±{(p.withSkillStddev * 100).toFixed(1)}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="font-mono tabular-nums">
                  <div className="flex items-baseline gap-1.5">
                    <span>{fmtPct(p.withoutSkillMean, 1)}</span>
                    {p.withoutSkillStddev !== null ? (
                      <span className="text-muted-foreground text-[10px]">
                        ±{(p.withoutSkillStddev * 100).toFixed(1)}
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
                            ? "negative"
                            : "muted"
                      }
                    >
                      {fmtDelta(delta)}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground font-mono tabular-nums">
                  {fmtTokens(p.withSkillTokensMean)}
                </TableCell>
                <TableCell className="text-muted-foreground font-mono tabular-nums">
                  {fmtSeconds(p.withSkillTimeSecondsMean)}
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
