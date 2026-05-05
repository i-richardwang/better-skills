"use client";

import dynamic from "next/dynamic";
import type { ResourceTrajectoryDatum } from "./resource-trajectory";

const ResourceTrajectoryGrid = dynamic(
  () =>
    import("./resource-trajectory").then((m) => m.ResourceTrajectoryGrid),
  {
    ssr: false,
    loading: () => (
      <div className="border-border text-muted-foreground flex h-56 items-center justify-center border border-dashed font-mono text-[10px] tracking-widest uppercase">
        loading resource charts…
      </div>
    ),
  },
);

export function ResourceTrajectoryGridClient({
  data,
  currentLabel,
  baselineLabel,
}: {
  data: ResourceTrajectoryDatum[];
  currentLabel?: string;
  baselineLabel?: string;
}) {
  return (
    <ResourceTrajectoryGrid
      data={data}
      currentLabel={currentLabel}
      baselineLabel={baselineLabel}
    />
  );
}

export type { ResourceTrajectoryDatum };
