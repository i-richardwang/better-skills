import type { EvalIterationResult, EvalRunResult } from "@/lib/queries";

// Pivots per-iteration, per-run expectation outcomes into a cross-iteration
// matrix. Pure compute — fed by getSkillEvalDetail's already-loaded data.
//
// Row identity is the expectation `text` string. If the user rewrites a
// text between iterations, the old row classifies as "removed" and the new
// one as "new" — that's intentional, since changing the text changes the
// assertion's meaning.

export type ExpectationCellTally = {
  passed: number;
  total: number;
  // evidence collected from each run where this expectation appeared, in
  // run-number order. Used for hover tooltips on cells.
  evidence: string[];
};

export type ExpectationCell = {
  current: ExpectationCellTally;
  baseline: ExpectationCellTally;
};

// Classification is computed from the *current* track only — baseline is
// shown in cells but not used to label "regression / newly passing", since
// the dashboard exists to track whether the live skill improves.
export type ExpectationClassification =
  | "regression" // current passed in some prior iter, fails in latest
  | "stuck_failing" // current fails in latest AND every prior occurrence
  | "flaky" // current fraction in (0,1) somewhere; mixed history
  | "newly_passing" // current passes in latest, was less-than-perfect prior
  | "new" // first appearance is in latest
  | "stable_pass" // current passes everywhere it appears
  | "removed"; // present in some prior iter, absent in latest

export type ExpectationMatrixIteration = {
  iterationNumber: number;
  baselineResolved: string | null;
};

export type ExpectationMatrixRow = {
  text: string;
  classification: ExpectationClassification;
  // keyed by iterationNumber. Missing = expectation didn't appear at all
  // for that iteration (neither config graded it).
  cells: Map<number, ExpectationCell>;
};

export type ExpectationMatrixSummary = {
  regressed: number;
  stuckFailing: number;
  flaky: number;
  newlyPassing: number;
  new: number;
  stablePass: number;
  removed: number;
};

export type ExpectationMatrix = {
  // newest-first, matches getSkillEvalDetail.iterations ordering
  iterations: ExpectationMatrixIteration[];
  // sorted by classification importance (regressions first, stable last)
  rows: ExpectationMatrixRow[];
  summary: ExpectationMatrixSummary;
};

function tally(text: string, runs: EvalRunResult[]): ExpectationCellTally {
  let passed = 0;
  let total = 0;
  const evidence: string[] = [];
  for (const run of runs) {
    const m = run.expectations.find((e) => e.text === text);
    if (!m) continue;
    total += 1;
    if (m.passed) passed += 1;
    if (m.evidence) evidence.push(m.evidence);
  }
  return { passed, total, evidence };
}

function classify(
  cells: Map<number, ExpectationCell>,
  itersNewestFirst: ExpectationMatrixIteration[],
): ExpectationClassification {
  const latestIter = itersNewestFirst[0]?.iterationNumber;
  if (latestIter === undefined) return "stable_pass";

  const latestCell = cells.get(latestIter);
  const latestCurrent = latestCell?.current;
  const inLatest = latestCurrent !== undefined && latestCurrent.total > 0;

  const priorCurrent: ExpectationCellTally[] = [];
  for (const it of itersNewestFirst.slice(1)) {
    const cell = cells.get(it.iterationNumber);
    if (cell && cell.current.total > 0) priorCurrent.push(cell.current);
  }

  if (!inLatest) {
    return priorCurrent.length > 0 ? "removed" : "removed";
  }
  if (priorCurrent.length === 0) return "new";

  const latestFraction = latestCurrent!.passed / latestCurrent!.total;
  const priorFractions = priorCurrent.map((c) => c.passed / c.total);
  const allPriorPass = priorFractions.every((f) => f === 1);
  const allPriorFail = priorFractions.every((f) => f === 0);

  if (latestFraction === 0 && priorFractions.some((f) => f > 0)) {
    return "regression";
  }
  if (latestFraction === 1 && priorFractions.some((f) => f < 1)) {
    return "newly_passing";
  }
  if (latestFraction === 1 && allPriorPass) return "stable_pass";
  if (latestFraction === 0 && allPriorFail) return "stuck_failing";
  return "flaky";
}

const CLASS_ORDER: Record<ExpectationClassification, number> = {
  regression: 0,
  stuck_failing: 1,
  flaky: 2,
  newly_passing: 3,
  new: 4,
  stable_pass: 5,
  removed: 6,
};

export function buildExpectationMatrix(
  iters: EvalIterationResult[],
): ExpectationMatrix {
  const iterations: ExpectationMatrixIteration[] = iters.map((it) => ({
    iterationNumber: it.iterationNumber,
    baselineResolved: it.baselineResolved,
  }));

  const allTexts = new Set<string>();
  for (const it of iters) {
    for (const r of [...it.currentRuns, ...it.baselineRuns]) {
      for (const e of r.expectations) allTexts.add(e.text);
    }
  }

  const rows: ExpectationMatrixRow[] = [];
  for (const text of allTexts) {
    const cells = new Map<number, ExpectationCell>();
    for (const it of iters) {
      cells.set(it.iterationNumber, {
        current: tally(text, it.currentRuns),
        baseline: tally(text, it.baselineRuns),
      });
    }
    rows.push({ text, classification: classify(cells, iterations), cells });
  }

  rows.sort((a, b) => {
    const co = CLASS_ORDER[a.classification] - CLASS_ORDER[b.classification];
    return co !== 0 ? co : a.text.localeCompare(b.text);
  });

  const summary: ExpectationMatrixSummary = {
    regressed: 0,
    stuckFailing: 0,
    flaky: 0,
    newlyPassing: 0,
    new: 0,
    stablePass: 0,
    removed: 0,
  };
  for (const r of rows) {
    switch (r.classification) {
      case "regression":
        summary.regressed += 1;
        break;
      case "stuck_failing":
        summary.stuckFailing += 1;
        break;
      case "flaky":
        summary.flaky += 1;
        break;
      case "newly_passing":
        summary.newlyPassing += 1;
        break;
      case "new":
        summary.new += 1;
        break;
      case "stable_pass":
        summary.stablePass += 1;
        break;
      case "removed":
        summary.removed += 1;
        break;
    }
  }

  return { iterations, rows, summary };
}
