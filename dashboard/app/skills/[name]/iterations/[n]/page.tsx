import Link from "next/link";
import { notFound } from "next/navigation";
import { getIterationDetail } from "@/lib/queries";
import type { RunRow } from "@/lib/queries";
import {
  fmtDateTime,
  fmtDelta,
  fmtInt,
  fmtPct,
  fmtRelative,
  fmtSeconds,
  fmtTokens,
  shortSha,
} from "@/lib/format";
import {
  Card,
  CardContent,
  CardEyebrow,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { EvalDefinition, Expectation } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function IterationPage({
  params,
}: {
  params: Promise<{ name: string; n: string }>;
}) {
  const { name: rawName, n: rawN } = await params;
  const name = decodeURIComponent(rawName);
  const n = parseInt(rawN, 10);
  if (Number.isNaN(n)) notFound();

  const iter = await getIterationDetail(name, n);
  if (!iter) notFound();

  const delta =
    iter.primaryMean !== null && iter.baselineMean !== null
      ? iter.primaryMean - iter.baselineMean
      : null;

  const primaryLabel = iter.primaryVariant ?? "primary";
  const baselineLabel = iter.baselineVariant ?? "baseline";
  const grouped = groupRunsByEval(iter.runs, iter.primaryVariant, iter.baselineVariant);
  const evalsById = new Map<number, EvalDefinition>();
  for (const e of iter.evalsDefinition ?? []) {
    evalsById.set(e.id, e);
  }

  return (
    <div className="space-y-10">
      <header className="space-y-4">
        <nav className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
          <Link href="/" className="hover:text-foreground">
            Portfolio
          </Link>
          <span className="mx-2">/</span>
          <Link
            href={`/skills/${encodeURIComponent(name)}`}
            className="hover:text-foreground"
          >
            {name}
          </Link>
          <span className="mx-2">/</span>
          <span className="text-foreground">
            iteration #{iter.iterationNumber}
          </span>
        </nav>
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <h1 className="font-heading text-4xl leading-[1.05] tracking-tight md:text-5xl">
            Iteration
            <span className="text-muted-foreground ml-3 font-mono text-3xl font-normal tabular-nums">
              #{iter.iterationNumber}
            </span>
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {iter.evalsCount ?? "—"} evals · {iter.runsPerConfiguration ?? "—"}{" "}
            runs/config
          </Badge>
          {iter.gitCommitSha ? (
            <Badge variant="secondary">commit {shortSha(iter.gitCommitSha)}</Badge>
          ) : null}
          {iter.hostname ? (
            <Badge variant="secondary">{iter.hostname}</Badge>
          ) : null}
          <Badge variant="outline" title={fmtDateTime(iter.uploadedAt)}>
            uploaded {fmtRelative(iter.uploadedAt)}
          </Badge>
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label={primaryLabel}
          value={fmtPct(iter.primaryMean)}
          hint={
            iter.primaryStddev !== null
              ? `σ ±${(iter.primaryStddev * 100).toFixed(1)}pp`
              : undefined
          }
        />
        <MetricCard
          label={baselineLabel}
          value={fmtPct(iter.baselineMean)}
          hint={
            iter.baselineStddev !== null
              ? `σ ±${(iter.baselineStddev * 100).toFixed(1)}pp`
              : undefined
          }
        />
        <MetricCard
          label="Delta"
          value={fmtDelta(delta)}
          tone={
            delta === null
              ? "secondary"
              : delta > 0
                ? "positive"
                : delta < 0
                  ? "destructive"
                  : "secondary"
          }
          hint={`${primaryLabel} − ${baselineLabel}`}
        />
        <MetricCard
          label="Cost ratio"
          value={
            iter.primaryTokensMean !== null &&
            iter.baselineTokensMean !== null &&
            iter.baselineTokensMean > 0
              ? `${(iter.primaryTokensMean / iter.baselineTokensMean).toFixed(2)}×`
              : "—"
          }
          hint={
            iter.primaryTokensMean !== null
              ? `${fmtTokens(iter.primaryTokensMean)} tokens`
              : undefined
          }
        />
      </section>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="min-w-0 space-y-4">
          <header className="border-border flex items-baseline justify-between border-b pb-3">
            <h2 className="font-heading text-xl tracking-tight">
              Run breakdown
            </h2>
            <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
              {iter.runs.length} total runs · grouped by eval
            </span>
          </header>
          {grouped.length === 0 ? (
            <Card>
              <CardContent className="text-muted-foreground text-center text-sm">
                No runs recorded for this iteration.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-6">
              {grouped.map((g) => (
                <EvalGroup
                  key={g.evalId}
                  group={g}
                  definition={evalsById.get(g.evalId) ?? null}
                  primaryLabel={primaryLabel}
                  baselineLabel={baselineLabel}
                />
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-6">
          <Card>
            <CardHeader>
              <CardEyebrow>Resource usage</CardEyebrow>
              <CardTitle className="text-base">
                Per-run averages ({primaryLabel})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <KV label="Tokens" value={fmtTokens(iter.primaryTokensMean)} />
              <KV
                label="Wall time"
                value={fmtSeconds(iter.primaryTimeSecondsMean)}
              />
              <div className="border-border my-2 border-t" />
              <KV
                label="Tokens (baseline)"
                value={fmtTokens(iter.baselineTokensMean)}
              />
              <KV
                label="Wall time (baseline)"
                value={fmtSeconds(iter.baselineTimeSecondsMean)}
              />
            </CardContent>
          </Card>

          {iter.notes && iter.notes.length > 0 ? (
            <Card>
              <CardHeader>
                <CardEyebrow>Notes</CardEyebrow>
                <CardTitle className="text-base">
                  From aggregation
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm leading-relaxed">
                  {iter.notes.map((n, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-muted-foreground font-mono text-[10px] leading-5 tracking-widest uppercase">
                        #{i + 1}
                      </span>
                      <span>{n}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          {iter.skillMdSnapshot ? (
            <Card>
              <CardHeader>
                <CardEyebrow>SKILL.md snapshot</CardEyebrow>
                <CardTitle className="text-base">
                  {fmtInt(iter.skillMdSnapshot.length)} chars
                </CardTitle>
              </CardHeader>
              <CardContent>
                <details className="group">
                  <summary className="text-muted-foreground hover:text-foreground cursor-pointer font-mono text-[10px] tracking-widest uppercase select-none">
                    expand snapshot ↓
                  </summary>
                  <pre className="bg-muted border-border mt-3 max-h-96 overflow-auto border px-3 py-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                    {iter.skillMdSnapshot}
                  </pre>
                </details>
              </CardContent>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function MetricCard({
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
          <div className="text-muted-foreground mt-1 font-mono text-[10px] tracking-widest uppercase">
            {hint}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
        {label}
      </span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}

type EvalBucket = {
  evalId: number;
  evalName: string | null;
  primary: RunRow[];
  baseline: RunRow[];
  other: RunRow[];
};

function groupRunsByEval(
  runs: RunRow[],
  primaryVariant: string | null,
  baselineVariant: string | null,
): EvalBucket[] {
  const map = new Map<number, EvalBucket>();
  for (const r of runs) {
    if (!map.has(r.evalId)) {
      map.set(r.evalId, {
        evalId: r.evalId,
        evalName: r.evalName,
        primary: [],
        baseline: [],
        other: [],
      });
    }
    const bucket = map.get(r.evalId)!;
    if (r.configuration === primaryVariant) bucket.primary.push(r);
    else if (r.configuration === baselineVariant) bucket.baseline.push(r);
    else bucket.other.push(r);
  }
  return [...map.values()].sort((a, b) => a.evalId - b.evalId);
}

function evalBucketMean(runs: RunRow[]): number | null {
  const rates = runs
    .map((r) => r.passRate)
    .filter((v): v is number => v !== null);
  if (rates.length === 0) return null;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}

const RUN_GRID =
  "grid grid-cols-[5.5rem_2.75rem_3.5rem_4.5rem_3.75rem_3.75rem_3rem_2.75rem_1rem] items-center gap-3";

function EvalGroup({
  group,
  definition,
  primaryLabel,
  baselineLabel,
}: {
  group: EvalBucket;
  definition: EvalDefinition | null;
  primaryLabel: string;
  baselineLabel: string;
}) {
  const primaryMean = evalBucketMean(group.primary);
  const baselineMean = evalBucketMean(group.baseline);
  const bucketDelta =
    primaryMean !== null && baselineMean !== null
      ? primaryMean - baselineMean
      : null;
  const rows = [...group.primary, ...group.baseline, ...group.other];

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardEyebrow>eval · #{group.evalId}</CardEyebrow>
          <CardTitle className="text-base">
            {group.evalName ?? `eval ${group.evalId}`}
          </CardTitle>
        </div>
        <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
          <span className="text-muted-foreground">
            {primaryLabel}: {fmtPct(primaryMean)} · {baselineLabel}: {fmtPct(baselineMean)}
          </span>
          {bucketDelta !== null ? (
            <Badge
              variant={
                bucketDelta > 0
                  ? "positive"
                  : bucketDelta < 0
                    ? "destructive"
                    : "secondary"
              }
            >
              {fmtDelta(bucketDelta)}
            </Badge>
          ) : null}
        </div>
      </CardHeader>

      {definition ? <EvalTaskDetails definition={definition} /> : null}

      <div className="overflow-x-auto">
        <div className="min-w-[44rem]">
          <div
            className={cn(
              RUN_GRID,
              "text-muted-foreground border-border border-b px-4 py-2.5 font-mono text-[10px] tracking-widest uppercase",
            )}
          >
            <span>Config</span>
            <span>Run</span>
            <span>Pass</span>
            <span>Passed/Total</span>
            <span>Tokens</span>
            <span>Time</span>
            <span>Tools</span>
            <span>Errors</span>
            <span aria-hidden />
          </div>

          {rows.map((r) => (
            <RunRowDetails
              key={r.id}
              run={r}
              primaryVariant={group.primary[0]?.configuration ?? null}
              baselineVariant={group.baseline[0]?.configuration ?? null}
            />
          ))}
        </div>
      </div>
    </Card>
  );
}

function RunRowDetails({
  run: r,
  primaryVariant,
  baselineVariant,
}: {
  run: RunRow;
  primaryVariant: string | null;
  baselineVariant: string | null;
}) {
  const hasExpectations = r.expectations.length > 0;
  const passedCount = r.expectations.filter((e) => e.passed).length;
  const isPrimary = r.configuration === primaryVariant;
  const isBaseline = r.configuration === baselineVariant;
  return (
    <details
      className={cn(
        "border-border group border-b last:border-b-0",
        hasExpectations
          ? "[&:not([open])]:hover:bg-muted/40"
          : "[&>summary]:cursor-default",
      )}
    >
      <summary
        className={cn(
          RUN_GRID,
          "list-none px-4 py-2.5 text-sm transition-colors",
          "[&::-webkit-details-marker]:hidden",
          hasExpectations
            ? "cursor-pointer group-open:bg-muted/60"
            : "",
        )}
      >
        <span>
          <Badge variant={isPrimary ? "outline" : isBaseline ? "secondary" : "secondary"}>
            {r.configuration}
          </Badge>
        </span>
        <span className="font-mono tabular-nums">#{r.runNumber}</span>
        <span className="font-mono font-medium tabular-nums">
          {fmtPct(r.passRate)}
        </span>
        <span className="text-muted-foreground font-mono tabular-nums">
          {r.passed ?? "—"} / {r.total ?? "—"}
        </span>
        <span className="text-muted-foreground font-mono tabular-nums">
          {fmtTokens(r.tokens)}
        </span>
        <span className="text-muted-foreground font-mono tabular-nums">
          {fmtSeconds(r.timeSeconds)}
        </span>
        <span className="text-muted-foreground font-mono tabular-nums">
          {fmtInt(r.toolCalls)}
        </span>
        <span className="font-mono tabular-nums">
          {r.errors !== null && r.errors > 0 ? (
            <span className="text-destructive">{r.errors}</span>
          ) : (
            <span className="text-muted-foreground">{r.errors ?? "—"}</span>
          )}
        </span>
        <span
          aria-hidden
          className={cn(
            "text-muted-foreground justify-self-end font-mono text-xs transition-transform",
            hasExpectations
              ? "group-open:rotate-90"
              : "opacity-20",
          )}
        >
          ›
        </span>
      </summary>

      {hasExpectations ? (
        <div className="bg-muted/30 border-border border-t px-4 py-3">
          <div className="text-muted-foreground mb-2 flex items-baseline justify-between font-mono text-[10px] tracking-widest uppercase">
            <span>Expectations</span>
            <span className="tabular-nums">
              {passedCount} / {r.expectations.length} passed
            </span>
          </div>
          <ul className="space-y-1.5">
            {r.expectations.map((e, i) => (
              <ExpectationRow key={i} expectation={e} />
            ))}
          </ul>
        </div>
      ) : null}
    </details>
  );
}

function EvalTaskDetails({ definition }: { definition: EvalDefinition }) {
  const { prompt, expectedOutput, files, expectations } = definition;
  const hasAny =
    !!prompt ||
    !!expectedOutput ||
    (files && files.length > 0) ||
    (expectations && expectations.length > 0);
  if (!hasAny) return null;

  return (
    <details className="border-border group border-t">
      <summary
        className={cn(
          "text-muted-foreground hover:bg-muted/40 flex cursor-pointer items-center gap-2 px-4 py-2.5 font-mono text-[10px] tracking-widest uppercase select-none",
          "list-none [&::-webkit-details-marker]:hidden",
        )}
      >
        <span
          aria-hidden
          className="inline-block transition-transform group-open:rotate-90"
        >
          ›
        </span>
        Task definition
      </summary>
      <div className="bg-muted/20 border-border space-y-4 border-t px-4 py-4 text-sm leading-relaxed">
        {prompt ? (
          <TaskField label="Prompt">
            <pre className="font-mono text-xs whitespace-pre-wrap">{prompt}</pre>
          </TaskField>
        ) : null}
        {expectedOutput ? (
          <TaskField label="Expected output">
            <p>{expectedOutput}</p>
          </TaskField>
        ) : null}
        {files && files.length > 0 ? (
          <TaskField label="Input files">
            <ul className="space-y-0.5 font-mono text-xs">
              {files.map((f, i) => (
                <li key={i} className="text-muted-foreground">
                  {f}
                </li>
              ))}
            </ul>
          </TaskField>
        ) : null}
        {expectations && expectations.length > 0 ? (
          <TaskField label="Expectations">
            <ul className="list-disc space-y-0.5 pl-4 text-sm">
              {expectations.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </TaskField>
        ) : null}
      </div>
    </details>
  );
}

function TaskField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-muted-foreground mb-1 font-mono text-[10px] tracking-widest uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}

function ExpectationRow({ expectation }: { expectation: Expectation }) {
  const { passed, text, evidence } = expectation;
  return (
    <li className="flex items-start gap-2.5">
      <span
        aria-hidden
        className={cn(
          "mt-[0.3rem] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center font-mono text-[10px] leading-none",
          passed
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : "bg-destructive/15 text-destructive",
        )}
      >
        {passed ? "✓" : "✗"}
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "text-sm leading-snug",
            passed ? "" : "text-destructive font-medium",
          )}
        >
          {text}
        </div>
        {evidence ? (
          <div className="text-muted-foreground mt-0.5 text-xs leading-snug">
            <span className="font-mono text-[10px] tracking-widest uppercase">
              evidence ·{" "}
            </span>
            {evidence}
          </div>
        ) : null}
      </div>
    </li>
  );
}
