"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";

export type TrajectoryDatum = {
  iteration: number;
  current: number | null;
  currentBandLow: number | null;
  currentBandHigh: number | null;
  baseline: number | null;
  baselineBandLow: number | null;
  baselineBandHigh: number | null;
};

type Props = {
  data: TrajectoryDatum[];
  // Display labels — defaults match the runner's fixed config names. Caller
  // can override `baselineLabel` to e.g. "baseline (iteration-1)" to surface
  // what the baseline actually pointed to.
  currentLabel?: string;
  baselineLabel?: string;
};

const C_CURRENT = "oklch(0.62 0.14 150)";
const C_BASELINE = "oklch(0.60 0.11 55)";

export function TrajectoryChart({
  data,
  currentLabel = "current",
  baselineLabel = "baseline",
}: Props) {
  const chartConfig = {
    current: { label: currentLabel, color: C_CURRENT },
    baseline: { label: baselineLabel, color: C_BASELINE },
  } satisfies ChartConfig;

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-80 w-full">
      <ComposedChart
        data={data}
        margin={{ top: 16, right: 16, bottom: 8, left: -8 }}
      >
          <defs>
            <linearGradient id="band-current" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C_CURRENT} stopOpacity={0.18} />
              <stop offset="100%" stopColor={C_CURRENT} stopOpacity={0.04} />
            </linearGradient>
            <linearGradient id="band-baseline" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C_BASELINE} stopOpacity={0.18} />
              <stop offset="100%" stopColor={C_BASELINE} stopOpacity={0.04} />
            </linearGradient>
          </defs>
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
          />
          <YAxis
            domain={[0, 1]}
            stroke="var(--muted-foreground)"
            fontSize={10}
            fontFamily="var(--font-mono)"
            tickFormatter={(v) => `${Math.round(v * 100)}%`}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip content={<ChartTooltip currentLabel={currentLabel} baselineLabel={baselineLabel} />} cursor={{ stroke: "var(--border)" }} />

          <Area
            type="monotone"
            dataKey="currentBandHigh"
            stroke="none"
            fill="url(#band-current)"
            activeDot={false}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="currentBandLow"
            stroke="none"
            fill="var(--background)"
            activeDot={false}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="baselineBandHigh"
            stroke="none"
            fill="url(#band-baseline)"
            activeDot={false}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="baselineBandLow"
            stroke="none"
            fill="var(--background)"
            activeDot={false}
            isAnimationActive={false}
          />

          <Line
            name={baselineLabel}
            type="monotone"
            dataKey="baseline"
            stroke={C_BASELINE}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={{ r: 3, fill: C_BASELINE, strokeWidth: 0 }}
            activeDot={{ r: 5, stroke: "var(--background)", strokeWidth: 2 }}
            isAnimationActive={false}
            connectNulls
          />
          <Line
            name={currentLabel}
            type="monotone"
            dataKey="current"
            stroke={C_CURRENT}
            strokeWidth={2}
            dot={{ r: 3.5, fill: C_CURRENT, strokeWidth: 0 }}
            activeDot={{ r: 5.5, stroke: "var(--background)", strokeWidth: 2 }}
            isAnimationActive={false}
            connectNulls
          />
      </ComposedChart>
    </ChartContainer>
  );
}

type TooltipPayloadEntry = {
  dataKey?: string;
  value?: number | null;
  payload?: TrajectoryDatum;
};

function ChartTooltip({
  active,
  payload,
  label,
  currentLabel,
  baselineLabel,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: number;
  currentLabel: string;
  baselineLabel: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const datum = payload[0]?.payload;
  if (!datum) return null;

  const row = (
    name: string,
    value: number | null,
    color: string,
    stddevLow?: number | null,
    stddevHigh?: number | null,
  ) => (
    <div className="flex items-baseline justify-between gap-4 tabular-nums">
      <span className="text-muted-foreground flex items-center gap-2 text-[10px] tracking-widest uppercase">
        <span
          aria-hidden
          className="inline-block h-2 w-2"
          style={{ background: color }}
        />
        {name}
      </span>
      <span className="font-mono">
        {value === null ? "—" : `${(value * 100).toFixed(1)}%`}
        {stddevLow !== null &&
        stddevLow !== undefined &&
        stddevHigh !== null &&
        stddevHigh !== undefined &&
        value !== null ? (
          <span className="text-muted-foreground ml-1 text-[10px]">
            ±{((stddevHigh - stddevLow) / 2 * 100).toFixed(1)}
          </span>
        ) : null}
      </span>
    </div>
  );

  return (
    <div className="border-border bg-background min-w-48 border px-3 py-2 shadow-sm">
      <div className="text-muted-foreground border-border mb-2 border-b pb-1 font-mono text-[10px] tracking-widest uppercase">
        iteration #{label}
      </div>
      <div className="space-y-1 text-sm">
        {row(
          currentLabel,
          datum.current,
          C_CURRENT,
          datum.currentBandLow,
          datum.currentBandHigh,
        )}
        {row(
          baselineLabel,
          datum.baseline,
          C_BASELINE,
          datum.baselineBandLow,
          datum.baselineBandHigh,
        )}
      </div>
    </div>
  );
}
