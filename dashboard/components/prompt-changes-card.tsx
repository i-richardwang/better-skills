import Link from "next/link";
import {
  Card,
  CardContent,
  CardEyebrow,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ResponsiveDiff,
  computeLineDiff,
  diffStats,
} from "@/components/diff-view";
import type { EvalMetadataEntry } from "@/lib/queries";
import { cn } from "@/lib/utils";

type Props = {
  skillName: string;
  current: EvalMetadataEntry[] | null;
  previous: EvalMetadataEntry[] | null;
  previousIterationNumber: number | null;
};

type CaseStatus = "added" | "removed" | "modified" | "unchanged";

type CaseEntry = {
  evalId: number;
  evalName: string | null;
  status: CaseStatus;
  current: EvalMetadataEntry | null;
  previous: EvalMetadataEntry | null;
  added: number;
  removed: number;
};

function buildEntries(
  current: EvalMetadataEntry[],
  previous: EvalMetadataEntry[] | null,
): CaseEntry[] {
  const curMap = new Map<number, EvalMetadataEntry>();
  for (const e of current) curMap.set(e.evalId, e);
  const prevMap = new Map<number, EvalMetadataEntry>();
  if (previous) for (const e of previous) prevMap.set(e.evalId, e);

  const allIds = new Set<number>();
  for (const id of curMap.keys()) allIds.add(id);
  for (const id of prevMap.keys()) allIds.add(id);

  const entries: CaseEntry[] = [];
  for (const id of allIds) {
    const c = curMap.get(id) ?? null;
    const p = prevMap.get(id) ?? null;
    let status: CaseStatus;
    let added = 0;
    let removed = 0;
    if (c && !p) {
      status = "added";
    } else if (!c && p) {
      status = "removed";
    } else if (c && p && c.prompt !== p.prompt) {
      status = "modified";
      const stats = diffStats(computeLineDiff(p.prompt, c.prompt));
      added = stats.added;
      removed = stats.removed;
    } else {
      status = "unchanged";
    }
    entries.push({
      evalId: id,
      evalName: c?.evalName ?? p?.evalName ?? null,
      status,
      current: c,
      previous: p,
      added,
      removed,
    });
  }
  entries.sort((a, b) => a.evalId - b.evalId);
  return entries;
}

// Renders only on iteration pages where there's a prior iter to diff against.
// For initial-iter or iters that predate eval_metadata capture, we silently
// render nothing — the rest of the Source diff section already covers
// "initial version" framing via SkillMdCard.
export function PromptChangesCard({
  skillName,
  current,
  previous,
  previousIterationNumber,
}: Props) {
  if (!current || current.length === 0) return null;
  const hasPrev = previous !== null && previousIterationNumber !== null;
  if (!hasPrev) return null;

  const entries = buildEntries(current, previous);
  const counts = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  for (const e of entries) counts[e.status] += 1;
  const changed = entries.filter((e) => e.status !== "unchanged");

  const totalCases = entries.length;
  const allUnchanged = changed.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardEyebrow>Prompts</CardEyebrow>
        <CardTitle className="text-base">
          <span className="font-mono tabular-nums">{totalCases} cases</span>
          {!allUnchanged ? (
            <>
              <span className="text-muted-foreground mx-2">·</span>
              <ChangeSummary
                added={counts.added}
                removed={counts.removed}
                modified={counts.modified}
              />{" "}
              <span className="text-muted-foreground text-xs font-normal">
                vs{" "}
                <Link
                  href={`/skills/${encodeURIComponent(skillName)}/iterations/${previousIterationNumber}`}
                  className="hover:text-foreground underline-offset-4 hover:underline"
                >
                  iter #{previousIterationNumber}
                </Link>
              </span>
            </>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-xs">
          {allUnchanged
            ? `All prompts identical to iteration #${previousIterationNumber}.`
            : `${changed.length} of ${totalCases} cases changed since iteration #${previousIterationNumber}.`}
        </p>
        {!allUnchanged ? <ChangedCaseList entries={changed} /> : null}
      </CardContent>
    </Card>
  );
}

function ChangeSummary({
  added,
  removed,
  modified,
}: {
  added: number;
  removed: number;
  modified: number;
}) {
  const parts: React.ReactNode[] = [];
  if (added > 0) {
    parts.push(
      <span
        key="add"
        className="text-emerald-600 dark:text-emerald-400"
      >{`+${added}`}</span>,
    );
  }
  if (removed > 0) {
    parts.push(
      <span
        key="del"
        className="text-rose-600 dark:text-rose-400"
      >{`−${removed}`}</span>,
    );
  }
  if (modified > 0) {
    parts.push(
      <span
        key="mod"
        className="text-amber-600 dark:text-amber-400"
      >{`~${modified}`}</span>,
    );
  }
  return (
    <span className="font-mono tabular-nums">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? " " : null}
          {p}
        </span>
      ))}
    </span>
  );
}

const STATUS_SYMBOL: Record<CaseStatus, string> = {
  added: "+",
  removed: "−",
  modified: "~",
  unchanged: " ",
};

const STATUS_COLOR: Record<CaseStatus, string> = {
  added: "text-emerald-600 dark:text-emerald-400",
  removed: "text-rose-600 dark:text-rose-400",
  modified: "text-amber-600 dark:text-amber-400",
  unchanged: "text-muted-foreground",
};

const STATUS_LABEL: Record<CaseStatus, string> = {
  added: "added",
  removed: "removed",
  modified: "modified",
  unchanged: "unchanged",
};

function ChangedCaseList({ entries }: { entries: CaseEntry[] }) {
  return (
    <div className="space-y-3">
      {entries.map((e) => (
        <ChangedCaseRow key={e.evalId} entry={e} />
      ))}
    </div>
  );
}

function ChangedCaseRow({ entry }: { entry: CaseEntry }) {
  const sym = STATUS_SYMBOL[entry.status];
  const symColor = STATUS_COLOR[entry.status];
  const titleEntry = entry.current ?? entry.previous!;
  const label = titleEntry.evalName ?? `eval ${entry.evalId}`;
  return (
    <details className="border-border group/case border" open>
      <summary
        className={cn(
          "bg-muted/40 hover:bg-muted/60 flex cursor-pointer items-baseline gap-2 px-3 py-2",
          "list-none [&::-webkit-details-marker]:hidden",
        )}
      >
        <span
          aria-hidden
          className="text-muted-foreground w-3 shrink-0 transition-transform group-open/case:rotate-90"
        >
          ›
        </span>
        <span className={cn("w-3 shrink-0 select-none font-mono", symColor)}>
          {sym}
        </span>
        <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
          #{entry.evalId}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {label}
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums">
          {entry.status === "modified" ? (
            <>
              <span className="text-emerald-600 dark:text-emerald-400">
                +{entry.added}
              </span>{" "}
              <span className="text-rose-600 dark:text-rose-400">
                −{entry.removed}
              </span>
            </>
          ) : (
            <span className={cn("text-[10px] tracking-widest uppercase", symColor)}>
              {STATUS_LABEL[entry.status]}
            </span>
          )}
        </span>
      </summary>
      <ChangedCaseBody entry={entry} />
    </details>
  );
}

function ChangedCaseBody({ entry }: { entry: CaseEntry }) {
  const cur = entry.status === "removed" ? null : entry.current;
  const prev = entry.status === "added" ? null : entry.previous;

  const tplCur = cur?.promptTemplateContent ?? null;
  const tplPrev = prev?.promptTemplateContent ?? null;
  const bodyCur = bodyContentOf(cur);
  const bodyPrev = bodyContentOf(prev);

  // If neither slot has content (e.g. iter that predates eval_metadata
  // capture and the case row only exists because of a path-only entry),
  // fall back to the resolved prompt as a single block.
  const noSlots =
    tplCur === null && tplPrev === null && bodyCur === null && bodyPrev === null;
  if (noSlots) {
    const fallback = entry.status === "removed" ? entry.previous : entry.current;
    if (!fallback) return null;
    return (
      <div className="border-border border-t">
        <CaseMeta current={cur} previous={prev} />
        <pre
          className={cn(
            "bg-muted max-h-[28rem] overflow-auto border-t border-border px-3 py-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap",
          )}
        >
          {fallback.prompt}
        </pre>
      </div>
    );
  }

  return (
    <div className="border-border border-t">
      <CaseMeta current={cur} previous={prev} />
      <PromptSlot label="Template" current={tplCur} previous={tplPrev} />
      <PromptSlot label="Body" current={bodyCur} previous={bodyPrev} />
    </div>
  );
}

// Body content sourcing strategy, in order:
//   1. prompt_file_content — the canonical case body when prompt_file is set
//   2. inline prompt derived from metadata.prompt — strip the template prefix
//      (template + "\n\n", per the runner's concat order in resolve_prompt_parts)
//   3. metadata.prompt verbatim — when no template is present
// Returns null only when the entry itself is null.
function bodyContentOf(e: EvalMetadataEntry | null): string | null {
  if (!e) return null;
  if (e.promptFileContent !== null) return e.promptFileContent;
  if (e.promptTemplateContent !== null) {
    const prefix = e.promptTemplateContent + "\n\n";
    return e.prompt.startsWith(prefix) ? e.prompt.slice(prefix.length) : e.prompt;
  }
  return e.prompt;
}

// One slot in a case body — either Template or Body content. Independent
// status from the case-level status: a case may be modified overall while
// the template stays unchanged and only the body diffs (or vice versa).
function PromptSlot({
  label,
  current,
  previous,
}: {
  label: string;
  current: string | null;
  previous: string | null;
}) {
  if (current === null && previous === null) return null;

  const header = (
    <div className="bg-muted/30 border-border text-muted-foreground border-t px-3 py-1.5 font-mono text-[10px] tracking-widest uppercase">
      {label}
    </div>
  );

  if (current !== null && previous !== null) {
    if (current === previous) {
      return (
        <>
          {header}
          <p className="text-muted-foreground border-border border-t px-3 py-2 font-mono text-[11px] italic">
            unchanged
          </p>
        </>
      );
    }
    const parts = computeLineDiff(previous, current);
    return (
      <>
        {header}
        <ResponsiveDiff parts={parts} className="border-x-0 border-b-0" />
      </>
    );
  }

  // One side null — slot was added or removed at the case level.
  const content = (current ?? previous)!;
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

// Surfaces template/file path info above each case body. When a path changed
// between iters (e.g. a case switched from inline to prompt_file), shows
// `previous → current`. When unchanged, shows the path once. When neither
// iter has the path slot populated, the row is omitted entirely.
function CaseMeta({
  current,
  previous,
}: {
  current: EvalMetadataEntry | null;
  previous: EvalMetadataEntry | null;
}) {
  const tplCur = current?.promptTemplatePath ?? null;
  const tplPrev = previous?.promptTemplatePath ?? null;
  const fileCur = current?.promptFilePath ?? null;
  const filePrev = previous?.promptFilePath ?? null;

  const hasTpl = tplCur !== null || tplPrev !== null;
  const hasFile = fileCur !== null || filePrev !== null;

  if (!hasTpl && !hasFile) return null;

  return (
    <div className="bg-muted/20 space-y-1 px-3 py-2 font-mono text-[11px]">
      {hasTpl ? (
        <PathRow label="template" current={tplCur} previous={tplPrev} />
      ) : null}
      {hasFile ? (
        <PathRow label="file" current={fileCur} previous={filePrev} />
      ) : null}
    </div>
  );
}

function PathRow({
  label,
  current,
  previous,
}: {
  label: string;
  current: string | null;
  previous: string | null;
}) {
  const labelEl = (
    <span className="text-muted-foreground w-16 shrink-0 text-[10px] tracking-widest uppercase">
      {label}
    </span>
  );
  if (current === previous) {
    return (
      <div className="flex items-baseline gap-2">
        {labelEl}
        <span className="text-muted-foreground">{current ?? "—"}</span>
      </div>
    );
  }
  if (previous === null) {
    return (
      <div className="flex items-baseline gap-2">
        {labelEl}
        <span className="text-emerald-700 dark:text-emerald-300">{current}</span>
        <span className="text-muted-foreground text-[10px] tracking-widest uppercase">
          new
        </span>
      </div>
    );
  }
  if (current === null) {
    return (
      <div className="flex items-baseline gap-2">
        {labelEl}
        <span className="text-rose-700 line-through opacity-70 dark:text-rose-300">
          {previous}
        </span>
        <span className="text-muted-foreground text-[10px] tracking-widest uppercase">
          removed
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-baseline gap-2">
      {labelEl}
      <span className="text-rose-700 line-through opacity-70 dark:text-rose-300">
        {previous}
      </span>
      <span className="text-muted-foreground">→</span>
      <span className="text-emerald-700 dark:text-emerald-300">{current}</span>
    </div>
  );
}
