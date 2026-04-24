"use client";

import dynamic from "next/dynamic";
import type { PerEvalTrajectoryDatum } from "./per-eval-trajectory";

const PerEvalTrajectoryGrid = dynamic(
  () =>
    import("./per-eval-trajectory").then((m) => m.PerEvalTrajectoryGrid),
  {
    ssr: false,
    loading: () => (
      <div className="border-border text-muted-foreground flex h-40 items-center justify-center border border-dashed font-mono text-[10px] tracking-widest uppercase">
        loading per-eval charts…
      </div>
    ),
  },
);

export function PerEvalTrajectoryGridClient({
  items,
}: {
  items: PerEvalTrajectoryDatum[];
}) {
  return <PerEvalTrajectoryGrid items={items} />;
}

export type { PerEvalTrajectoryDatum };
