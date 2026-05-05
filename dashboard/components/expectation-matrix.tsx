import {
  Card,
  CardContent,
  CardEyebrow,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  ExpectationCell,
  ExpectationCellTally,
  ExpectationClassification,
  ExpectationMatrix,
  ExpectationMatrixIteration,
  ExpectationMatrixRow,
  ExpectationMatrixSummary,
} from "@/lib/expectation-matrix";
import { cn } from "@/lib/utils";

const CLASS_BADGE: Record<
  ExpectationClassification,
  { label: string; cls: string }
> = {
  regression: {
    label: "regressed",
    cls: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  },
  stuck_failing: {
    label: "stuck",
    cls: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
  flaky: {
    label: "flaky",
    cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  newly_passing: {
    label: "newly passing",
    cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  new: { label: "new", cls: "bg-muted text-muted-foreground" },
  stable_pass: { label: "stable", cls: "bg-muted/40 text-muted-foreground" },
  removed: {
    label: "removed",
    cls: "bg-muted/40 text-muted-foreground line-through",
  },
};

export function ExpectationMatrixCard({
  matrix,
}: {
  matrix: ExpectationMatrix;
}) {
  if (matrix.rows.length === 0 || matrix.iterations.length === 0) return null;
  const { iterations, rows, summary } = matrix;
  const latestIterN = iterations[0]?.iterationNumber ?? null;

  return (
    <Card>
      <CardHeader>
        <CardEyebrow>Expectations · cross-iteration</CardEyebrow>
        <CardTitle className="text-base">
          <span className="font-mono tabular-nums">{rows.length}</span>{" "}
          expectation{rows.length === 1 ? "" : "s"} tracked
          {latestIterN !== null ? (
            <>
              <span className="text-muted-foreground mx-2">·</span>
              <span className="text-muted-foreground text-xs font-normal">
                latest = iter{" "}
                <span className="font-mono tabular-nums">#{latestIterN}</span>
              </span>
            </>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <SummaryStrip summary={summary} />
        <MatrixTable iterations={iterations} rows={rows} />
        <Legend />
      </CardContent>
    </Card>
  );
}

function SummaryStrip({ summary }: { summary: ExpectationMatrixSummary }) {
  // Order matches CLASS_ORDER importance — most-actionable first.
  const items = [
    {
      key: "regressed",
      label: "regressed",
      count: summary.regressed,
      cls: "text-rose-700 dark:text-rose-300",
    },
    {
      key: "stuck",
      label: "stuck",
      count: summary.stuckFailing,
      cls: "text-rose-600 dark:text-rose-400",
    },
    {
      key: "flaky",
      label: "flaky",
      count: summary.flaky,
      cls: "text-amber-700 dark:text-amber-300",
    },
    {
      key: "newly",
      label: "newly passing",
      count: summary.newlyPassing,
      cls: "text-emerald-700 dark:text-emerald-300",
    },
    {
      key: "new",
      label: "new",
      count: summary.new,
      cls: "text-muted-foreground",
    },
    {
      key: "stable",
      label: "stable",
      count: summary.stablePass,
      cls: "text-muted-foreground",
    },
    {
      key: "removed",
      label: "removed",
      count: summary.removed,
      cls: "text-muted-foreground",
    },
  ].filter((it) => it.count > 0);

  if (items.length === 0) return null;

  return (
    <div className="border-border bg-muted/20 flex flex-wrap gap-x-6 gap-y-3 border px-4 py-3">
      {items.map((it) => (
        <div key={it.key} className="flex items-baseline gap-1.5 font-mono">
          <span className={cn("text-2xl font-medium tabular-nums", it.cls)}>
            {it.count}
          </span>
          <span className="text-muted-foreground text-[10px] tracking-widest uppercase">
            {it.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function MatrixTable({
  iterations,
  rows,
}: {
  iterations: ExpectationMatrixIteration[];
  rows: ExpectationMatrixRow[];
}) {
  return (
    <div className="border-border overflow-x-auto border">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th
              scope="col"
              className="bg-muted/40 border-border text-muted-foreground sticky left-0 z-10 min-w-[18rem] border-b border-r px-3 py-2 text-left font-mono text-[10px] tracking-widest uppercase"
            >
              Expectation
            </th>
            {iterations.map((it) => (
              <th
                key={it.iterationNumber}
                scope="col"
                className="bg-muted/40 border-border text-muted-foreground border-b px-3 py-2 text-left font-mono text-[10px] tracking-widest uppercase tabular-nums min-w-[6.5rem]"
              >
                #{it.iterationNumber}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <MatrixRow
              key={`${row.text}-${i}`}
              row={row}
              iterations={iterations}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatrixRow({
  row,
  iterations,
}: {
  row: ExpectationMatrixRow;
  iterations: ExpectationMatrixIteration[];
}) {
  const badge = CLASS_BADGE[row.classification];
  return (
    <tr className="group">
      <th
        scope="row"
        className="bg-background border-border sticky left-0 z-10 max-w-md border-b border-r px-3 py-2.5 text-left align-top font-normal group-last:border-b-0"
      >
        <div className="flex flex-col gap-1.5">
          <span
            className={cn(
              "inline-flex w-fit px-1.5 py-0.5 font-mono text-[10px] tracking-widest uppercase",
              badge.cls,
            )}
          >
            {badge.label}
          </span>
          <span className="text-sm leading-snug">{row.text}</span>
        </div>
      </th>
      {iterations.map((it) => {
        const cell = row.cells.get(it.iterationNumber) ?? null;
        return (
          <td
            key={it.iterationNumber}
            className="border-border border-b px-3 py-2.5 align-middle group-last:border-b-0"
          >
            <CellRender cell={cell} baselineResolved={it.baselineResolved} />
          </td>
        );
      })}
    </tr>
  );
}

function CellRender({
  cell,
  baselineResolved,
}: {
  cell: ExpectationCell | null;
  baselineResolved: string | null;
}) {
  if (
    cell === null ||
    (cell.current.total === 0 && cell.baseline.total === 0)
  ) {
    return (
      <span className="text-muted-foreground/40 font-mono text-[11px]">—</span>
    );
  }
  const baselineLabel = baselineResolved
    ? `baseline (${baselineResolved})`
    : "baseline";
  return (
    <div className="flex flex-col gap-1">
      <TallyMini tally={cell.current} variant="current" label="current" />
      <TallyMini tally={cell.baseline} variant="baseline" label={baselineLabel} />
    </div>
  );
}

function TallyMini({
  tally,
  variant,
  label,
}: {
  tally: ExpectationCellTally;
  variant: "current" | "baseline";
  label: string;
}) {
  if (tally.total === 0) {
    return (
      <span className="text-muted-foreground/40 font-mono text-[10px]">—</span>
    );
  }
  const passColor =
    variant === "current"
      ? "bg-emerald-500/80 dark:bg-emerald-400/80"
      : "bg-amber-600/70 dark:bg-amber-300/70";
  const failColor = "bg-muted-foreground/15";
  const cells = Array.from({ length: tally.total }, (_, i) => i < tally.passed);
  const evidenceTip =
    tally.evidence.length > 0
      ? `\n\n${tally.evidence.map((e, i) => `run ${i + 1}: ${e}`).join("\n")}`
      : "";
  const tip = `${label}: ${tally.passed}/${tally.total} passed${evidenceTip}`;
  return (
    <span className="flex items-center gap-1.5" title={tip}>
      <span className="flex gap-0.5">
        {cells.map((pass, i) => (
          <span
            key={i}
            aria-hidden
            className={cn("h-2.5 w-2.5 shrink-0", pass ? passColor : failColor)}
          />
        ))}
      </span>
      <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
        {tally.passed}/{tally.total}
      </span>
    </span>
  );
}

function Legend() {
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] tracking-widest uppercase">
      <span>cells:</span>
      <LegendDot
        cls="bg-emerald-500/80 dark:bg-emerald-400/80"
        label="current pass"
      />
      <LegendDot
        cls="bg-amber-600/70 dark:bg-amber-300/70"
        label="baseline pass"
      />
      <LegendDot cls="bg-muted-foreground/15" label="fail" />
      <span className="ml-2 normal-case tracking-normal">
        hover a cell for evidence
      </span>
    </div>
  );
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn("h-2.5 w-2.5", cls)} />
      <span>{label}</span>
    </span>
  );
}
