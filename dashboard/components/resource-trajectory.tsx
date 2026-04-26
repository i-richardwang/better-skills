"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { fmtSeconds, fmtSecondsCompact, fmtTokens } from "@/lib/format";

export type ResourceTrajectoryDatum = {
  iteration: number;
  primaryTokens: number | null;
  baselineTokens: number | null;
  primarySeconds: number | null;
  baselineSeconds: number | null;
};

const C_PRIMARY = "oklch(0.62 0.14 150)";
const C_BASELINE = "oklch(0.60 0.11 55)";

type Metric = "tokens" | "seconds";

export function ResourceTrajectoryGrid({
  data,
  primaryLabel = "primary",
  baselineLabel = "baseline",
}: {
  data: ResourceTrajectoryDatum[];
  primaryLabel?: string;
  baselineLabel?: string;
}) {
  if (data.length === 0) {
    return (
      <div className="border-border text-muted-foreground flex h-40 items-center justify-center border border-dashed font-mono text-[10px] tracking-widest uppercase">
        No resource data yet
      </div>
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <ResourcePanel
        title="Tokens"
        subtitle="mean per run"
        metric="tokens"
        data={data}
        primaryLabel={primaryLabel}
        baselineLabel={baselineLabel}
      />
      <ResourcePanel
        title="Time"
        subtitle="mean wall-clock per run"
        metric="seconds"
        data={data}
        primaryLabel={primaryLabel}
        baselineLabel={baselineLabel}
      />
    </div>
  );
}

function ResourcePanel({
  title,
  subtitle,
  metric,
  data,
  primaryLabel,
  baselineLabel,
}: {
  title: string;
  subtitle: string;
  metric: Metric;
  data: ResourceTrajectoryDatum[];
  primaryLabel: string;
  baselineLabel: string;
}) {
  const primaryKey = metric === "tokens" ? "primaryTokens" : "primarySeconds";
  const baselineKey = metric === "tokens" ? "baselineTokens" : "baselineSeconds";
  const fmt = metric === "tokens" ? fmtTokens : fmtSeconds;
  const axisFmt = metric === "tokens" ? fmtTokens : fmtSecondsCompact;

  const chartConfig = {
    primary: { label: primaryLabel, color: C_PRIMARY },
    baseline: { label: baselineLabel, color: C_BASELINE },
  } satisfies ChartConfig;

  const latest = data[data.length - 1];
  const latestPrimary = latest?.[primaryKey] ?? null;
  const latestBaseline = latest?.[baselineKey] ?? null;

  return (
    <div className="border-border bg-card flex flex-col border">
      <div className="border-border flex items-baseline justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
            {subtitle}
          </div>
          <div className="font-heading truncate text-base tracking-tight">
            {title}
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5 font-mono tabular-nums">
          <span className="text-xl font-medium">{fmt(latestPrimary)}</span>
          <span className="text-muted-foreground text-[10px] tracking-widest uppercase">
            vs {fmt(latestBaseline)}
          </span>
        </div>
      </div>
      <ChartContainer
        config={chartConfig}
        className="aspect-auto h-56 w-full px-1 py-2"
      >
        <LineChart
          data={data}
          margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
        >
            <CartesianGrid
              stroke="var(--border)"
              strokeDasharray="2 4"
              vertical={false}
            />
            <XAxis
              dataKey="iteration"
              type="number"
              domain={["dataMin", "dataMax"]}
              allowDecimals={false}
              stroke="var(--muted-foreground)"
              fontSize={10}
              fontFamily="var(--font-mono)"
              tickFormatter={(v) => `#${v}`}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              interval="preserveStartEnd"
            />
            <YAxis
              stroke="var(--muted-foreground)"
              fontSize={10}
              fontFamily="var(--font-mono)"
              tickFormatter={(v) => axisFmt(v)}
              tickLine={false}
              axisLine={false}
              width={40}
              domain={[0, "auto"]}
            />
            <Tooltip
              content={<ResourceTooltip metric={metric} primaryLabel={primaryLabel} baselineLabel={baselineLabel} />}
              cursor={{ stroke: "var(--border)" }}
            />
            <Line
              name={baselineLabel}
              type="monotone"
              dataKey={baselineKey}
              stroke={C_BASELINE}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={{ r: 2.5, fill: C_BASELINE, strokeWidth: 0 }}
              activeDot={{ r: 4.5, stroke: "var(--background)", strokeWidth: 1.5 }}
              isAnimationActive={false}
              connectNulls
            />
            <Line
              name={primaryLabel}
              type="monotone"
              dataKey={primaryKey}
              stroke={C_PRIMARY}
              strokeWidth={2}
              dot={{ r: 3, fill: C_PRIMARY, strokeWidth: 0 }}
              activeDot={{ r: 5, stroke: "var(--background)", strokeWidth: 1.5 }}
              isAnimationActive={false}
              connectNulls
            />
        </LineChart>
      </ChartContainer>
    </div>
  );
}

type TooltipPayloadEntry = {
  payload?: ResourceTrajectoryDatum;
};

function ResourceTooltip({
  active,
  payload,
  label,
  metric,
  primaryLabel,
  baselineLabel,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: number;
  metric: Metric;
  primaryLabel: string;
  baselineLabel: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const datum = payload[0]?.payload;
  if (!datum) return null;

  const fmt = metric === "tokens" ? fmtTokens : fmtSeconds;
  const primaryVal =
    metric === "tokens" ? datum.primaryTokens : datum.primarySeconds;
  const baselineVal =
    metric === "tokens" ? datum.baselineTokens : datum.baselineSeconds;

  const row = (name: string, v: number | null, color: string) => (
    <div className="flex items-baseline justify-between gap-4 tabular-nums">
      <span className="text-muted-foreground flex items-center gap-2 text-[10px] tracking-widest uppercase">
        <span
          aria-hidden
          className="inline-block h-2 w-2"
          style={{ background: color }}
        />
        {name}
      </span>
      <span className="font-mono">{fmt(v)}</span>
    </div>
  );

  return (
    <div className="border-border bg-background min-w-44 border px-3 py-2 shadow-sm">
      <div className="text-muted-foreground border-border mb-2 border-b pb-1 font-mono text-[10px] tracking-widest uppercase">
        iteration #{label}
      </div>
      <div className="space-y-1 text-sm">
        {row(primaryLabel, primaryVal, C_PRIMARY)}
        {row(baselineLabel, baselineVal, C_BASELINE)}
      </div>
    </div>
  );
}
