import Link from "next/link";
import { notFound } from "next/navigation";
import { getSkillEvalDetail } from "@/lib/queries";
import type {
  EvalIterationResult,
  EvalMetadataEntry,
  EvalRunResult,
  Expectation,
} from "@/lib/queries";
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
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  TrajectoryChartClient,
  type TrajectoryDatum,
} from "@/components/trajectory-chart-client";
import { ExpectationMatrixCard } from "@/components/expectation-matrix";
import {
  ResponsiveDiff,
  computeLineDiff,
  diffStats,
} from "@/components/diff-view";
import { buildExpectationMatrix } from "@/lib/expectation-matrix";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function EvalDetailPage({
  params,
}: {
  params: Promise<{ name: string; id: string }>;
}) {
  const { name: rawName, id: rawId } = await params;
  const name = decodeURIComponent(rawName);
  const evalId = parseInt(rawId, 10);
  if (Number.isNaN(evalId)) notFound();

  const detail = await getSkillEvalDetail(name, evalId);
  if (!detail) notFound();

  const trajectoryData: TrajectoryDatum[] = detail.trajectory.map((p) => ({
    iteration: p.iterationNumber,
    current: p.currentMean,
    currentBandLow: null,
    currentBandHigh: null,
    baseline: p.baselineMean,
    baselineBandLow: null,
    baselineBandHigh: null,
  }));

  // Configs are fixed names ("current"/"baseline"). Baseline label includes
  // the resolved spec from the latest iteration so users see what was
  // compared against in the most-recent run. Older iterations may have
  // compared against different baselines — those still display correctly
  // because each row uses its own iteration's baselineResolved.
  const latestIter = detail.iterations[0] ?? null;
  const currentLabel = "current";
  const baselineLabel = latestIter?.baselineResolved
    ? `baseline (${latestIter.baselineResolved})`
    : "baseline";

  const latest = detail.trajectory[detail.trajectory.length - 1] ?? null;
  const first = detail.trajectory[0] ?? null;
  const latestDelta =
    latest &&
    latest.currentMean !== null &&
    latest.baselineMean !== null
      ? latest.currentMean - latest.baselineMean
      : null;
  const lifetimeDelta =
    latest &&
    first &&
    latest.currentMean !== null &&
    first.currentMean !== null
      ? latest.currentMean - first.currentMean
      : null;

  const evalLabel = detail.evalName ?? `eval ${detail.evalId}`;

  // Canonical expectation list — prefer definition; fall back to first run's
  // expectation texts if definition isn't uploaded.
  const canonicalExpectations: string[] =
    detail.definition?.expectations ??
    inferExpectationTextsFromIterations(detail.iterations);

  const matrix = buildExpectationMatrix(detail.iterations);

  return (
    <div className="space-y-12">
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
          <span className="text-foreground">eval #{detail.evalId}</span>
        </nav>
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <h1 className="font-heading text-4xl leading-[1.05] tracking-tight md:text-5xl">
            {evalLabel}
          </h1>
          <span className="text-muted-foreground font-mono text-sm tabular-nums">
            #{detail.evalId}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {detail.iterations.length} iteration
            {detail.iterations.length === 1 ? "" : "s"}
          </Badge>
          {latest?.currentMean !== null &&
          latest?.currentMean !== undefined ? (
            <Badge variant="secondary">
              latest {currentLabel}: {fmtPct(latest.currentMean)}
            </Badge>
          ) : null}
          {latestDelta !== null ? (
            <Badge
              variant={
                latestDelta > 0
                  ? "positive"
                  : latestDelta < 0
                    ? "destructive"
                    : "secondary"
              }
            >
              vs {baselineLabel} {fmtDelta(latestDelta)}
            </Badge>
          ) : null}
          {lifetimeDelta !== null ? (
            <Badge
              variant={
                lifetimeDelta > 0
                  ? "positive"
                  : lifetimeDelta < 0
                    ? "destructive"
                    : "secondary"
              }
            >
              lifetime {fmtDelta(lifetimeDelta)}
            </Badge>
          ) : null}
        </div>
      </header>

      <TaskSection
        skillName={name}
        iterations={detail.iterations}
        fallbackPrompt={detail.definition?.prompt ?? null}
        expectedOutput={detail.definition?.expectedOutput ?? null}
        files={detail.definition?.files ?? null}
        expectations={canonicalExpectations}
      />

      <section className="space-y-4">
        <SectionHeading
          title="Pass-rate trajectory"
          subtitle="this eval, across iterations"
        />
        <Card>
          <CardContent className="px-2 py-2">
            {trajectoryData.length === 0 ? (
              <div className="text-muted-foreground flex h-80 items-center justify-center font-mono text-[10px] tracking-widest uppercase">
                no data
              </div>
            ) : (
              <TrajectoryChartClient
                data={trajectoryData}
                currentLabel={currentLabel}
                baselineLabel={baselineLabel}
              />
            )}
          </CardContent>
        </Card>
      </section>

      {matrix.rows.length > 0 ? (
        <section className="space-y-4">
          <SectionHeading
            title="Expectation matrix"
            subtitle="which expectations changed across iterations"
          />
          <ExpectationMatrixCard matrix={matrix} />
        </section>
      ) : null}

      <section className="space-y-6">
        <SectionHeading
          title="Iteration results"
          subtitle={`${detail.iterations.length} run${detail.iterations.length === 1 ? "" : "s"} · newest first`}
        />
        <div className="space-y-6">
          {detail.iterations.map((it) => (
            <IterationResult
              key={it.iterationId}
              iteration={it}
              expectationTexts={canonicalExpectations}
              skillName={name}
            />
          ))}
          {/* labels are derived per-iteration in IterationResult */}
        </div>
      </section>
    </div>
  );
}

function inferExpectationTextsFromIterations(
  iters: EvalIterationResult[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of iters) {
    for (const r of [...it.currentRuns, ...it.baselineRuns]) {
      for (const e of r.expectations) {
        if (!seen.has(e.text)) {
          seen.add(e.text);
          out.push(e.text);
        }
      }
    }
  }
  return out;
}

function SectionHeading({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="border-border flex items-baseline justify-between border-b pb-3">
      <h2 className="font-heading text-xl tracking-tight">{title}</h2>
      {subtitle ? (
        <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
          {subtitle}
        </span>
      ) : null}
    </header>
  );
}

// Body content sourcing — same priority order as the runner's
// resolve_prompt_parts: explicit prompt_file > template-stripped inline >
// raw inline. Returns null when the entry itself is null.
function bodyContentOf(e: EvalMetadataEntry | null): string | null {
  if (!e) return null;
  if (e.promptFileContent !== null) return e.promptFileContent;
  if (e.promptTemplateContent !== null) {
    const prefix = e.promptTemplateContent + "\n\n";
    return e.prompt.startsWith(prefix) ? e.prompt.slice(prefix.length) : e.prompt;
  }
  return e.prompt;
}

// iterations[] is newest-first (per getSkillEvalDetail return). Latest =
// iterations[0]. Returns the most recent iteration that actually has
// metadata (older iters predate eval_metadata capture).
function latestWithMetadata(
  iterations: EvalIterationResult[],
): EvalIterationResult | null {
  for (const it of iterations) {
    if (it.evalMetadata) return it;
  }
  return null;
}

type EvolutionStep = {
  current: EvalIterationResult;
  previous: EvalIterationResult;
  templateChanged: boolean;
  bodyChanged: boolean;
  templateAdded: number;
  templateRemoved: number;
  bodyAdded: number;
  bodyRemoved: number;
};

// Walks newest→oldest pairwise across iterations that have metadata,
// emitting one step for each iter where template OR body changed vs the
// nearest prior iter with metadata. Iters that predate metadata capture
// are skipped silently (no fake "added" step against null).
function buildEvolution(
  iterations: EvalIterationResult[],
): EvolutionStep[] {
  const withMeta = iterations.filter((it) => it.evalMetadata !== null);
  const steps: EvolutionStep[] = [];
  for (let i = 0; i < withMeta.length - 1; i++) {
    const cur = withMeta[i];
    const prev = withMeta[i + 1];
    const tplCur = cur.evalMetadata?.promptTemplateContent ?? null;
    const tplPrev = prev.evalMetadata?.promptTemplateContent ?? null;
    const bodyCur = bodyContentOf(cur.evalMetadata);
    const bodyPrev = bodyContentOf(prev.evalMetadata);
    const templateChanged = tplCur !== tplPrev;
    const bodyChanged = bodyCur !== bodyPrev;
    if (!templateChanged && !bodyChanged) continue;

    let templateAdded = 0;
    let templateRemoved = 0;
    if (templateChanged && tplCur !== null && tplPrev !== null) {
      const s = diffStats(computeLineDiff(tplPrev, tplCur));
      templateAdded = s.added;
      templateRemoved = s.removed;
    }
    let bodyAdded = 0;
    let bodyRemoved = 0;
    if (bodyChanged && bodyCur !== null && bodyPrev !== null) {
      const s = diffStats(computeLineDiff(bodyPrev, bodyCur));
      bodyAdded = s.added;
      bodyRemoved = s.removed;
    }

    steps.push({
      current: cur,
      previous: prev,
      templateChanged,
      bodyChanged,
      templateAdded,
      templateRemoved,
      bodyAdded,
      bodyRemoved,
    });
  }
  return steps;
}

function TaskSection({
  skillName,
  iterations,
  fallbackPrompt,
  expectedOutput,
  files,
  expectations,
}: {
  skillName: string;
  iterations: EvalIterationResult[];
  fallbackPrompt: string | null;
  expectedOutput: string | null;
  files: string[] | null;
  expectations: string[];
}) {
  const latest = latestWithMetadata(iterations);
  const evolution = buildEvolution(iterations);
  const hasMetadata = latest !== null;
  const hasContent =
    hasMetadata ||
    !!fallbackPrompt ||
    !!expectedOutput ||
    (files && files.length > 0) ||
    expectations.length > 0;

  return (
    <section className="space-y-4">
      <SectionHeading title="Task" subtitle="what the agent is asked to do" />
      {!hasContent ? (
        <Card>
          <CardContent className="text-muted-foreground text-sm">
            No task definition uploaded for this eval. Upload the skill&apos;s{" "}
            <code className="font-mono text-xs">evals.json</code> with the{" "}
            <code className="font-mono text-xs">--skill-path</code> flag to see
            prompt and expected output here.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {hasMetadata ? (
            <PromptCard
              skillName={skillName}
              latest={latest}
              evolution={evolution}
            />
          ) : fallbackPrompt ? (
            <Card>
              <CardContent>
                <Field label="Prompt">
                  <pre className="bg-muted/40 border-border overflow-auto border-l-2 px-4 py-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap">
                    {fallbackPrompt}
                  </pre>
                </Field>
              </CardContent>
            </Card>
          ) : null}

          {expectedOutput ||
          (files && files.length > 0) ||
          expectations.length > 0 ? (
            <Card>
              <CardContent className="space-y-6">
                {expectedOutput ? (
                  <Field label="Expected output">
                    <p className="text-sm leading-relaxed">{expectedOutput}</p>
                  </Field>
                ) : null}
                {files && files.length > 0 ? (
                  <Field label="Input files">
                    <ul className="space-y-0.5 font-mono text-xs">
                      {files.map((f, i) => (
                        <li key={i} className="text-muted-foreground">
                          {f}
                        </li>
                      ))}
                    </ul>
                  </Field>
                ) : null}
                {expectations.length > 0 ? (
                  <Field label="Expectations">
                    <ul className="space-y-1 text-sm">
                      {expectations.map((e, i) => (
                        <li key={i} className="flex gap-2.5">
                          <span className="text-muted-foreground font-mono text-[10px] leading-5 tabular-nums">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <span className="leading-snug">{e}</span>
                        </li>
                      ))}
                    </ul>
                  </Field>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </section>
  );
}

function PromptCard({
  skillName,
  latest,
  evolution,
}: {
  skillName: string;
  latest: EvalIterationResult;
  evolution: EvolutionStep[];
}) {
  const meta = latest.evalMetadata!;
  const tpl = meta.promptTemplateContent;
  const tplPath = meta.promptTemplatePath;
  const body = bodyContentOf(meta);
  const filePath = meta.promptFilePath;

  return (
    <Card>
      <CardContent className="space-y-6">
        <div className="text-muted-foreground flex flex-wrap items-baseline justify-between gap-2 font-mono text-[10px] tracking-widest uppercase">
          <span>Prompt · iteration #{latest.iterationNumber}</span>
          {evolution.length > 0 ? (
            <span>
              {evolution.length} change{evolution.length === 1 ? "" : "s"} across
              history
            </span>
          ) : null}
        </div>

        {tpl !== null || tplPath !== null ? (
          <PromptSlotBlock
            label="Template"
            sublabel={tplPath ?? undefined}
            content={tpl}
            framing="template"
          />
        ) : null}

        <PromptSlotBlock
          label="Body"
          sublabel={filePath ?? undefined}
          content={body}
          framing="body"
        />

        {evolution.length > 0 ? (
          <EvolutionBlock skillName={skillName} steps={evolution} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function PromptSlotBlock({
  label,
  sublabel,
  content,
  framing,
}: {
  label: string;
  sublabel: string | undefined;
  content: string | null;
  framing: "template" | "body";
}) {
  // Body is the case's distinctive input, so it expands by default. Template
  // is shared scaffolding — collapse to keep the page readable.
  const open = framing === "body";
  return (
    <details className="border-border group/slot border" open={open}>
      <summary
        className={cn(
          "bg-muted/40 hover:bg-muted/60 flex cursor-pointer flex-wrap items-baseline gap-2 px-3 py-2",
          "list-none [&::-webkit-details-marker]:hidden",
        )}
      >
        <span
          aria-hidden
          className="text-muted-foreground w-3 shrink-0 transition-transform group-open/slot:rotate-90"
        >
          ›
        </span>
        <span className="text-muted-foreground shrink-0 font-mono text-[10px] tracking-widest uppercase">
          {label}
        </span>
        {sublabel ? (
          <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
            {sublabel}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
      </summary>
      {content !== null ? (
        <pre className="bg-muted border-border max-h-[36rem] overflow-auto border-t px-4 py-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">
          {content}
        </pre>
      ) : (
        <p className="text-muted-foreground border-border border-t px-4 py-3 font-mono text-xs italic">
          content not captured for this iteration
        </p>
      )}
    </details>
  );
}

function EvolutionBlock({
  skillName,
  steps,
}: {
  skillName: string;
  steps: EvolutionStep[];
}) {
  return (
    <details className="border-border group/evo border" open={false}>
      <summary
        className={cn(
          "bg-muted/40 hover:bg-muted/60 flex cursor-pointer items-baseline gap-2 px-3 py-2",
          "list-none [&::-webkit-details-marker]:hidden",
        )}
      >
        <span
          aria-hidden
          className="text-muted-foreground w-3 shrink-0 transition-transform group-open/evo:rotate-90"
        >
          ›
        </span>
        <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
          Prompt evolution
        </span>
        <span className="text-muted-foreground font-mono text-xs">
          {steps.length} change{steps.length === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="border-border border-t">
        {steps.map((s) => (
          <EvolutionStepView
            key={s.current.iterationId}
            skillName={skillName}
            step={s}
          />
        ))}
      </div>
    </details>
  );
}

function EvolutionStepView({
  skillName,
  step,
}: {
  skillName: string;
  step: EvolutionStep;
}) {
  const tplCur = step.current.evalMetadata?.promptTemplateContent ?? null;
  const tplPrev = step.previous.evalMetadata?.promptTemplateContent ?? null;
  const bodyCur = bodyContentOf(step.current.evalMetadata);
  const bodyPrev = bodyContentOf(step.previous.evalMetadata);

  return (
    <details className="border-border group/step border-b last:border-b-0" open>
      <summary
        className={cn(
          "bg-muted/20 hover:bg-muted/40 flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2",
          "list-none [&::-webkit-details-marker]:hidden",
        )}
      >
        <span
          aria-hidden
          className="text-muted-foreground w-3 shrink-0 transition-transform group-open/step:rotate-90"
        >
          ›
        </span>
        <span className="font-mono text-xs">
          <Link
            href={`/skills/${encodeURIComponent(skillName)}/iterations/${step.current.iterationNumber}`}
            className="hover:underline"
          >
            iter #{step.current.iterationNumber}
          </Link>
          <span className="text-muted-foreground mx-1.5">vs</span>
          <Link
            href={`/skills/${encodeURIComponent(skillName)}/iterations/${step.previous.iterationNumber}`}
            className="hover:underline"
          >
            #{step.previous.iterationNumber}
          </Link>
        </span>
        <span className="ml-auto flex items-baseline gap-3 font-mono text-xs tabular-nums">
          {step.templateChanged ? (
            <span>
              <span className="text-muted-foreground text-[10px] tracking-widest uppercase">
                tpl
              </span>{" "}
              <span className="text-emerald-600 dark:text-emerald-400">
                +{step.templateAdded}
              </span>{" "}
              <span className="text-rose-600 dark:text-rose-400">
                −{step.templateRemoved}
              </span>
            </span>
          ) : null}
          {step.bodyChanged ? (
            <span>
              <span className="text-muted-foreground text-[10px] tracking-widest uppercase">
                body
              </span>{" "}
              <span className="text-emerald-600 dark:text-emerald-400">
                +{step.bodyAdded}
              </span>{" "}
              <span className="text-rose-600 dark:text-rose-400">
                −{step.bodyRemoved}
              </span>
            </span>
          ) : null}
        </span>
      </summary>

      {step.templateChanged ? (
        <PromptDiffSlot label="Template" current={tplCur} previous={tplPrev} />
      ) : null}
      {step.bodyChanged ? (
        <PromptDiffSlot label="Body" current={bodyCur} previous={bodyPrev} />
      ) : null}
    </details>
  );
}

function PromptDiffSlot({
  label,
  current,
  previous,
}: {
  label: string;
  current: string | null;
  previous: string | null;
}) {
  const header = (
    <div className="bg-muted/30 border-border text-muted-foreground border-t px-3 py-1.5 font-mono text-[10px] tracking-widest uppercase">
      {label}
    </div>
  );
  if (current !== null && previous !== null) {
    const parts = computeLineDiff(previous, current);
    return (
      <>
        {header}
        <ResponsiveDiff parts={parts} className="border-x-0 border-b-0" />
      </>
    );
  }
  const content = current ?? previous;
  if (content === null) return null;
  const isAdded = previous === null;
  return (
    <>
      {header}
      <pre
        className={cn(
          "border-border max-h-[28rem] overflow-auto border-t px-3 py-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap",
          isAdded
            ? "bg-emerald-500/5 text-emerald-900 dark:text-emerald-100"
            : "bg-rose-500/5 text-rose-900 dark:text-rose-100",
        )}
      >
        {content}
      </pre>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-muted-foreground mb-2 font-mono text-[10px] tracking-widest uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}

function IterationResult({
  iteration,
  expectationTexts,
  skillName,
}: {
  iteration: EvalIterationResult;
  expectationTexts: string[];
  skillName: string;
}) {
  const currentAvg = mean(iteration.currentRuns.map((r) => r.passRate));
  const baselineAvg = mean(iteration.baselineRuns.map((r) => r.passRate));
  const delta =
    currentAvg !== null && baselineAvg !== null ? currentAvg - baselineAvg : null;
  const currentLabel = "current";
  const baselineLabel = iteration.baselineResolved
    ? `baseline (${iteration.baselineResolved})`
    : "baseline";

  return (
    <Card>
      <header className="border-border flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b px-5 py-4">
        <div className="flex items-baseline gap-3">
          <Link
            href={`/skills/${encodeURIComponent(skillName)}/iterations/${iteration.iterationNumber}`}
            className="font-heading text-lg tracking-tight hover:underline"
          >
            iteration #{iteration.iterationNumber}
          </Link>
          {iteration.gitCommitSha ? (
            <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
              {shortSha(iteration.gitCommitSha)}
            </span>
          ) : null}
          <span
            className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase"
            title={fmtDateTime(iteration.uploadedAt)}
          >
            {fmtRelative(iteration.uploadedAt)}
          </span>
        </div>
        <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
          <span className="text-muted-foreground">
            {currentLabel}: {fmtPct(currentAvg)} · {baselineLabel}: {fmtPct(baselineAvg)}
          </span>
          {delta !== null ? (
            <Badge
              variant={
                delta > 0 ? "positive" : delta < 0 ? "destructive" : "secondary"
              }
            >
              {fmtDelta(delta)}
            </Badge>
          ) : null}
        </div>
      </header>

      {expectationTexts.length > 0 ? (
        <div className="border-border border-b">
          <div className="text-muted-foreground border-border grid grid-cols-[1fr_8rem_8rem] items-baseline gap-3 border-b px-5 py-2.5 font-mono text-[10px] tracking-widest uppercase">
            <span>Expectations</span>
            <span className="text-right">{currentLabel}</span>
            <span className="text-right">{baselineLabel}</span>
          </div>
          <ul>
            {expectationTexts.map((text, i) => (
              <ExpectationCompareRow
                key={i}
                text={text}
                currentRuns={iteration.currentRuns}
                baselineRuns={iteration.baselineRuns}
              />
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <div className="text-muted-foreground border-border grid grid-cols-[2.5rem_1fr_1fr] items-baseline gap-3 border-b px-5 py-2.5 font-mono text-[10px] tracking-widest uppercase">
          <span>Run</span>
          <span>{currentLabel}</span>
          <span>{baselineLabel}</span>
        </div>
        <RunPairs
          currentRuns={iteration.currentRuns}
          baselineRuns={iteration.baselineRuns}
        />
      </div>
    </Card>
  );
}

function mean(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null);
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function ExpectationCompareRow({
  text,
  currentRuns,
  baselineRuns,
}: {
  text: string;
  currentRuns: EvalRunResult[];
  baselineRuns: EvalRunResult[];
}) {
  const currentTally = tallyExpectation(text, currentRuns);
  const baselineTally = tallyExpectation(text, baselineRuns);

  return (
    <li className="border-border grid grid-cols-[1fr_8rem_8rem] items-center gap-3 border-b px-5 py-2.5 last:border-b-0">
      <span className="pr-2 text-sm leading-snug">{text}</span>
      <TallyCell tally={currentTally} variant="current" />
      <TallyCell tally={baselineTally} variant="baseline" />
    </li>
  );
}

type Tally = { passed: number; total: number };

function tallyExpectation(text: string, runs: EvalRunResult[]): Tally {
  let passed = 0;
  let total = 0;
  for (const run of runs) {
    const match = run.expectations.find((e) => e.text === text);
    if (!match) continue;
    total += 1;
    if (match.passed) passed += 1;
  }
  return { passed, total };
}

function TallyCell({
  tally,
  variant,
}: {
  tally: Tally;
  variant: "current" | "baseline";
}) {
  const { passed, total } = tally;
  if (total === 0) {
    return (
      <span className="text-muted-foreground justify-self-end font-mono text-xs">
        —
      </span>
    );
  }

  const cells: ("pass" | "fail")[] = [];
  for (let i = 0; i < total; i++) {
    cells.push(i < passed ? "pass" : "fail");
  }

  const passColor =
    variant === "current"
      ? "bg-emerald-500/80 dark:bg-emerald-400/80"
      : "bg-amber-600/70 dark:bg-amber-300/70";
  const failColor = "bg-muted-foreground/15";

  return (
    <span className="flex items-center justify-end gap-2">
      <span className="flex gap-0.5">
        {cells.map((c, i) => (
          <span
            key={i}
            aria-hidden
            className={cn(
              "h-3 w-3 shrink-0",
              c === "pass" ? passColor : failColor,
            )}
          />
        ))}
      </span>
      <span className="font-mono text-xs tabular-nums">
        {passed}/{total}
      </span>
    </span>
  );
}

function RunPairs({
  currentRuns,
  baselineRuns,
}: {
  currentRuns: EvalRunResult[];
  baselineRuns: EvalRunResult[];
}) {
  const runNumbers = new Set<number>();
  for (const r of currentRuns) runNumbers.add(r.runNumber);
  for (const r of baselineRuns) runNumbers.add(r.runNumber);
  const sorted = [...runNumbers].sort((a, b) => a - b);

  return (
    <ul>
      {sorted.map((n) => {
        const p = currentRuns.find((r) => r.runNumber === n) ?? null;
        const b = baselineRuns.find((r) => r.runNumber === n) ?? null;
        return <RunPairRow key={n} runNumber={n} currentRun={p} baselineRun={b} />;
      })}
    </ul>
  );
}

function RunPairRow({
  runNumber,
  currentRun,
  baselineRun,
}: {
  runNumber: number;
  currentRun: EvalRunResult | null;
  baselineRun: EvalRunResult | null;
}) {
  const failedExp = (run: EvalRunResult | null): Expectation[] =>
    run ? run.expectations.filter((e) => !e.passed) : [];

  const currentFailed = failedExp(currentRun);
  const baselineFailed = failedExp(baselineRun);
  const hasDetails = currentFailed.length > 0 || baselineFailed.length > 0;

  return (
    <li className="border-border border-b last:border-b-0">
      <details className="group">
        <summary
          className={cn(
            "grid grid-cols-[2.5rem_1fr_1fr] items-baseline gap-3 px-5 py-2.5 text-sm",
            "list-none [&::-webkit-details-marker]:hidden",
            hasDetails ? "hover:bg-muted/40 cursor-pointer" : "cursor-default",
          )}
        >
          <span className="font-mono tabular-nums">
            #{runNumber}
            {hasDetails ? (
              <span
                aria-hidden
                className="text-muted-foreground ml-1 inline-block transition-transform group-open:rotate-90"
              >
                ›
              </span>
            ) : null}
          </span>
          <RunMetricCell run={currentRun} />
          <RunMetricCell run={baselineRun} />
        </summary>
        {hasDetails ? (
          <div className="bg-muted/20 border-border grid grid-cols-[2.5rem_1fr_1fr] gap-3 border-t px-5 py-3">
            <span aria-hidden />
            <FailureList runFailed={currentFailed} variant="current" />
            <FailureList runFailed={baselineFailed} variant="baseline" />
          </div>
        ) : null}
      </details>
    </li>
  );
}

function RunMetricCell({ run }: { run: EvalRunResult | null }) {
  if (!run) {
    return <span className="text-muted-foreground font-mono text-xs">—</span>;
  }
  return (
    <div className="space-y-0.5 font-mono text-xs tabular-nums">
      <div>
        <span className="font-medium">{fmtPct(run.passRate)}</span>
        <span className="text-muted-foreground ml-1.5">
          ({run.passed ?? "—"}/{run.total ?? "—"})
        </span>
      </div>
      <div className="text-muted-foreground">
        {fmtTokens(run.tokens)} · {fmtSeconds(run.timeSeconds)} · {fmtInt(run.toolCalls)} tools
        {run.errors !== null && run.errors > 0 ? (
          <span className="text-destructive ml-1.5">
            · {run.errors} err
          </span>
        ) : null}
      </div>
    </div>
  );
}

function FailureList({
  runFailed,
  variant,
}: {
  runFailed: Expectation[];
  variant: "current" | "baseline";
}) {
  if (runFailed.length === 0) {
    return (
      <span
        className={cn(
          "font-mono text-[10px] tracking-widest uppercase",
          variant === "current"
            ? "text-emerald-700 dark:text-emerald-300"
            : "text-amber-700 dark:text-amber-300",
        )}
      >
        all passed
      </span>
    );
  }
  return (
    <ul className="space-y-1.5">
      {runFailed.map((e, i) => (
        <li key={i} className="flex gap-2 text-xs leading-snug">
          <span aria-hidden className="text-destructive font-mono">
            ✗
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-destructive font-medium">{e.text}</div>
            {e.evidence ? (
              <div className="text-muted-foreground mt-0.5">{e.evidence}</div>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
