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
import {
  ChangeSummary,
  type DiffStatus,
  RowStats,
  StatusGlyph,
  defaultOpenForStatus,
  summaryBgForStatus,
} from "@/components/diff-card-primitives";
import type { EvalMetadataEntry } from "@/lib/queries";
import { cn } from "@/lib/utils";

type Props = {
  skillName: string;
  current: EvalMetadataEntry[] | null;
  previous: EvalMetadataEntry[] | null;
  previousIterationNumber: number | null;
};

type Consumer = { evalId: number; evalName: string | null };

type TemplateEntry = {
  path: string;
  status: DiffStatus;
  currentContent: string | null;
  previousContent: string | null;
  consumers: Consumer[];
  added: number;
  removed: number;
};

// Same template path can be referenced by N cases. We dedupe by path so the
// content + diff renders once with a "used by N cases" badge — the iteration
// page is a skill-level view, and templates are skill-level infrastructure.
// Assumes all cases sharing one path within an iter carry identical content
// (true at runner-time — single file read). Picks the first non-null content
// if any case captured it.
function buildEntries(
  current: EvalMetadataEntry[],
  previous: EvalMetadataEntry[] | null,
): TemplateEntry[] {
  const curByPath = new Map<string, { content: string | null; consumers: Consumer[] }>();
  for (const e of current) {
    if (!e.promptTemplatePath) continue;
    const slot = curByPath.get(e.promptTemplatePath) ?? {
      content: e.promptTemplateContent,
      consumers: [],
    };
    if (slot.content === null && e.promptTemplateContent !== null) {
      slot.content = e.promptTemplateContent;
    }
    slot.consumers.push({ evalId: e.evalId, evalName: e.evalName });
    curByPath.set(e.promptTemplatePath, slot);
  }

  const prevByPath = new Map<string, string | null>();
  if (previous) {
    for (const e of previous) {
      if (!e.promptTemplatePath) continue;
      if (!prevByPath.has(e.promptTemplatePath)) {
        prevByPath.set(e.promptTemplatePath, e.promptTemplateContent);
      } else {
        const existing = prevByPath.get(e.promptTemplatePath);
        if (existing === null && e.promptTemplateContent !== null) {
          prevByPath.set(e.promptTemplatePath, e.promptTemplateContent);
        }
      }
    }
  }

  const allPaths = new Set<string>();
  for (const p of curByPath.keys()) allPaths.add(p);
  for (const p of prevByPath.keys()) allPaths.add(p);

  const entries: TemplateEntry[] = [];
  for (const path of allPaths) {
    const cur = curByPath.get(path) ?? null;
    const prevContent = prevByPath.has(path)
      ? (prevByPath.get(path) ?? null)
      : null;
    const inPrev = prevByPath.has(path);

    let status: DiffStatus;
    let added = 0;
    let removed = 0;
    if (cur && !inPrev) {
      status = "added";
    } else if (!cur && inPrev) {
      status = "removed";
    } else if (
      cur &&
      inPrev &&
      cur.content !== null &&
      prevContent !== null &&
      cur.content !== prevContent
    ) {
      status = "modified";
      const stats = diffStats(computeLineDiff(prevContent, cur.content));
      added = stats.added;
      removed = stats.removed;
    } else {
      status = "unchanged";
    }
    entries.push({
      path,
      status,
      currentContent: cur?.content ?? null,
      previousContent: prevContent,
      consumers: cur?.consumers ?? [],
      added,
      removed,
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

// Surfaces shared prompt templates as skill-level infrastructure on the
// iteration page. A template referenced by N cases shows once, not N times,
// with consumer badges that deeplink to per-case eval pages. Hides itself
// when no template is in use this iter.
export function PromptTemplatesCard({
  skillName,
  current,
  previous,
  previousIterationNumber,
}: Props) {
  if (!current || current.length === 0) return null;
  const entries = buildEntries(current, previous);
  if (entries.length === 0) return null;

  const hasPrev = previous !== null && previousIterationNumber !== null;
  const counts = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  for (const e of entries) counts[e.status] += 1;
  const changed = entries.filter((e) => e.status !== "unchanged");
  const allUnchanged = hasPrev && changed.length === 0;
  const showChanges = hasPrev && changed.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardEyebrow>Prompt templates</CardEyebrow>
        <CardTitle className="text-base">
          <span className="font-mono tabular-nums">
            {entries.length} template{entries.length === 1 ? "" : "s"}
          </span>
          {showChanges ? (
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
          {!hasPrev
            ? `Initial snapshot — shared prompt scaffolding referenced by case bodies.`
            : allUnchanged
              ? `All templates identical to iteration #${previousIterationNumber}.`
              : `${changed.length} of ${entries.length} template${entries.length === 1 ? "" : "s"} changed since iteration #${previousIterationNumber}.`}
        </p>
        <TemplateList
          skillName={skillName}
          entries={hasPrev ? changed : entries}
          mode={hasPrev ? "diff" : "snapshot"}
        />
      </CardContent>
    </Card>
  );
}

function TemplateList({
  skillName,
  entries,
  mode,
}: {
  skillName: string;
  entries: TemplateEntry[];
  mode: "diff" | "snapshot";
}) {
  if (entries.length === 0) return null;
  return (
    <div className="space-y-3">
      {entries.map((e) => (
        <TemplateRow
          key={e.path}
          skillName={skillName}
          entry={e}
          mode={mode}
        />
      ))}
    </div>
  );
}

function TemplateRow({
  skillName,
  entry,
  mode,
}: {
  skillName: string;
  entry: TemplateEntry;
  mode: "diff" | "snapshot";
}) {
  return (
    <details
      className="border-border group/template border"
      open={defaultOpenForStatus(entry.status, mode)}
    >
      <summary
        className={cn(
          "hover:bg-muted/60 flex cursor-pointer flex-wrap items-baseline gap-2 px-3 py-2",
          "list-none [&::-webkit-details-marker]:hidden",
          summaryBgForStatus(entry.status),
        )}
      >
        <span
          aria-hidden
          className="text-muted-foreground w-3 shrink-0 transition-transform group-open/template:rotate-90"
        >
          ›
        </span>
        {mode === "diff" ? <StatusGlyph status={entry.status} /> : null}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {entry.path}
        </span>
        {mode === "diff" ? (
          <RowStats
            status={entry.status}
            added={entry.added}
            removed={entry.removed}
          />
        ) : null}
      </summary>
      <ConsumersRow skillName={skillName} consumers={entry.consumers} />
      <TemplateBody entry={entry} />
    </details>
  );
}

function ConsumersRow({
  skillName,
  consumers,
}: {
  skillName: string;
  consumers: Consumer[];
}) {
  if (consumers.length === 0) return null;
  return (
    <div className="border-border bg-muted/20 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t px-3 py-2 font-mono text-[11px]">
      <span className="text-muted-foreground text-[10px] tracking-widest uppercase">
        used by {consumers.length} case{consumers.length === 1 ? "" : "s"}
      </span>
      {consumers.map((c) => (
        <Link
          key={c.evalId}
          href={`/skills/${encodeURIComponent(skillName)}/evals/${c.evalId}`}
          className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
        >
          #{c.evalId}
          {c.evalName ? <span className="ml-1">{c.evalName}</span> : null}
        </Link>
      ))}
    </div>
  );
}

function TemplateBody({ entry }: { entry: TemplateEntry }) {
  if (
    entry.status === "modified" &&
    entry.currentContent !== null &&
    entry.previousContent !== null
  ) {
    const parts = computeLineDiff(entry.previousContent, entry.currentContent);
    return <ResponsiveDiff parts={parts} className="border-x-0 border-b-0 border-t" />;
  }
  if (entry.status === "unchanged" && entry.currentContent !== null) {
    return (
      <pre className="bg-muted border-border max-h-[28rem] overflow-auto border-t px-3 py-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {entry.currentContent}
      </pre>
    );
  }
  const content =
    entry.status === "removed" ? entry.previousContent : entry.currentContent;
  if (!content) {
    return (
      <p className="text-muted-foreground border-border border-t px-3 py-2 font-mono text-[11px] italic">
        content not captured
      </p>
    );
  }
  return (
    <pre
      className={cn(
        "border-border max-h-[28rem] overflow-auto border-t px-3 py-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap",
        entry.status === "added"
          ? "bg-emerald-500/5 text-emerald-900 dark:text-emerald-100"
          : entry.status === "removed"
            ? "bg-rose-500/5 text-rose-900 dark:text-rose-100"
            : "bg-muted",
      )}
    >
      {content}
    </pre>
  );
}
