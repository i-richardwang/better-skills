"use client";

import dynamic from "next/dynamic";
import type { TrajectoryDatum } from "./trajectory-chart";

const TrajectoryChart = dynamic(
  () => import("./trajectory-chart").then((m) => m.TrajectoryChart),
  {
    ssr: false,
    loading: () => (
      <div className="text-muted-foreground flex h-80 items-center justify-center font-mono text-[10px] tracking-widest uppercase">
        loading chart…
      </div>
    ),
  },
);

export function TrajectoryChartClient({
  data,
  currentLabel,
  baselineLabel,
}: {
  data: TrajectoryDatum[];
  currentLabel?: string;
  baselineLabel?: string;
}) {
  return (
    <TrajectoryChart
      data={data}
      currentLabel={currentLabel}
      baselineLabel={baselineLabel}
    />
  );
}

export type { TrajectoryDatum };
