"use client";

import Link from "next/link";
import {
  CartesianGrid,
  LineChart,
  Line,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { fmtDelta, fmtPct } from "@/lib/format";

export type PerEvalPoint = {
  iterationNumber: number;
  withSkillMean: number | null;
  withoutSkillMean: number | null;
};

export type PerEvalTrajectoryDatum = {
  evalId: number;
  evalName: string | null;
  points: PerEvalPoint[];
};

const C_WITH = "oklch(0.62 0.14 150)";
const C_WITHOUT = "oklch(0.60 0.11 55)";

const chartConfig = {
  with_skill: { label: "with_skill", color: C_WITH },
  without_skill: { label: "without_skill", color: C_WITHOUT },
} satisfies ChartConfig;

export function PerEvalTrajectorySparkline({
  evalName,
  evalId,
  points,
  skillName,
}: PerEvalTrajectoryDatum & { skillName?: string }) {
  if (points.length === 0) return null;

  const latest = points[points.length - 1];
  const first = points[0];
  const delta =
    latest?.withSkillMean != null && first?.withSkillMean != null
      ? latest.withSkillMean - first.withSkillMean
      : null;

  const tile = (
    <div className="border-border bg-card hover:border-foreground/40 flex h-full flex-col border transition-colors">
      <div className="border-border flex items-baseline justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
            eval · #{evalId}
          </div>
          <div className="font-heading truncate text-base tracking-tight">
            {evalName ?? `eval ${evalId}`}
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5 font-mono tabular-nums">
          <span className="text-xl font-medium">
            {fmtPct(latest?.withSkillMean ?? null, 0)}
          </span>
          {delta !== null ? (
            <span
              className={
                "text-[10px] tracking-widest uppercase " +
                (delta > 0
                  ? "text-emerald-600 dark:text-emerald-300"
                  : delta < 0
                    ? "text-destructive"
                    : "text-muted-foreground")
              }
            >
              {fmtDelta(delta)}
            </span>
          ) : null}
        </div>
      </div>
      <ChartContainer
        config={chartConfig}
        className="aspect-auto h-40 w-full px-1 py-1"
      >
        <LineChart data={points} margin={{ top: 6, right: 10, bottom: 0, left: 4 }}>
            <CartesianGrid
              stroke="var(--border)"
              strokeDasharray="2 4"
              vertical={false}
            />
            <XAxis
              dataKey="iterationNumber"
              type="number"
              domain={["dataMin", "dataMax"]}
              allowDecimals={false}
              stroke="var(--muted-foreground)"
              fontSize={9}
              fontFamily="var(--font-mono)"
              tickFormatter={(v) => `#${v}`}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              interval="preserveStartEnd"
            />
            {/* Sparkline: headline already shows latest %, scale is implicit
                [0,1]. Hide axis to reclaim width — keep YAxis for grid ticks. */}
            <YAxis domain={[0, 1]} ticks={[0, 0.5, 1]} hide />
            <Tooltip content={<MiniTooltip />} cursor={{ stroke: "var(--border)" }} />
            <Line
              type="monotone"
              dataKey="withoutSkillMean"
              stroke={C_WITHOUT}
              strokeWidth={1.25}
              strokeDasharray="4 3"
              dot={{ r: 2, fill: C_WITHOUT, strokeWidth: 0 }}
              activeDot={{ r: 4, stroke: "var(--background)", strokeWidth: 1.5 }}
              isAnimationActive={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="withSkillMean"
              stroke={C_WITH}
              strokeWidth={1.75}
              dot={{ r: 2.5, fill: C_WITH, strokeWidth: 0 }}
              activeDot={{ r: 4.5, stroke: "var(--background)", strokeWidth: 1.5 }}
              isAnimationActive={false}
              connectNulls
            />
        </LineChart>
      </ChartContainer>
    </div>
  );

  if (skillName) {
    return (
      <Link
        href={`/skills/${encodeURIComponent(skillName)}/evals/${evalId}`}
        className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
      >
        {tile}
      </Link>
    );
  }
  return tile;
}

type MiniTooltipProps = {
  active?: boolean;
  payload?: Array<{ payload?: PerEvalPoint }>;
  label?: number;
};

function MiniTooltip({ active, payload, label }: MiniTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  const row = (name: string, v: number | null, color: string) => (
    <div className="flex items-baseline justify-between gap-3 tabular-nums">
      <span className="text-muted-foreground flex items-center gap-1.5 text-[10px] tracking-widest uppercase">
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5"
          style={{ background: color }}
        />
        {name}
      </span>
      <span className="font-mono">
        {v === null ? "—" : `${(v * 100).toFixed(0)}%`}
      </span>
    </div>
  );
  return (
    <div className="border-border bg-background min-w-40 border px-2.5 py-1.5 shadow-sm">
      <div className="text-muted-foreground border-border mb-1 border-b pb-1 font-mono text-[10px] tracking-widest uppercase">
        iter #{label}
      </div>
      <div className="space-y-0.5 text-xs">
        {row("with", d.withSkillMean, C_WITH)}
        {row("without", d.withoutSkillMean, C_WITHOUT)}
      </div>
    </div>
  );
}

export function PerEvalTrajectoryGrid({
  items,
  skillName,
}: {
  items: PerEvalTrajectoryDatum[];
  skillName?: string;
}) {
  if (items.length === 0) {
    return (
      <div className="border-border text-muted-foreground flex h-28 items-center justify-center border border-dashed font-mono text-[10px] tracking-widest uppercase">
        No per-eval data yet
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((ev) => (
        <PerEvalTrajectorySparkline
          key={ev.evalId}
          {...ev}
          skillName={skillName}
        />
      ))}
    </div>
  );
}
