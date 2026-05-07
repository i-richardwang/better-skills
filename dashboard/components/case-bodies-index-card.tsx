import Link from "next/link";
import {
  Card,
  CardContent,
  CardEyebrow,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { computeLineDiff, diffStats } from "@/components/diff-view";
import {
  ChangeSummary,
  type DiffStatus,
  RowStats,
  StatusGlyph,
} from "@/components/diff-card-primitives";
import type { EvalMetadataEntry } from "@/lib/queries";
import { cn } from "@/lib/utils";

type Props = {
  skillName: string;
  current: EvalMetadataEntry[] | null;
  previous: EvalMetadataEntry[] | null;
  previousIterationNumber: number | null;
};

type BodyEntry = {
  evalId: number;
  evalName: string | null;
  status: DiffStatus;
  added: number;
  removed: number;
};

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

function buildEntries(
  current: EvalMetadataEntry[],
  previous: EvalMetadataEntry[] | null,
): BodyEntry[] {
  const curMap = new Map<number, EvalMetadataEntry>();
  for (const e of current) curMap.set(e.evalId, e);
  const prevMap = new Map<number, EvalMetadataEntry>();
  if (previous) for (const e of previous) prevMap.set(e.evalId, e);

  const allIds = new Set<number>();
  for (const id of curMap.keys()) allIds.add(id);
  for (const id of prevMap.keys()) allIds.add(id);

  const entries: BodyEntry[] = [];
  for (const id of allIds) {
    const c = curMap.get(id) ?? null;
    const p = prevMap.get(id) ?? null;
    const cBody = bodyContentOf(c);
    const pBody = bodyContentOf(p);

    let status: DiffStatus;
    let added = 0;
    let removed = 0;
    if (c && !p) {
      status = "added";
    } else if (!c && p) {
      status = "removed";
    } else if (cBody !== null && pBody !== null && cBody !== pBody) {
      status = "modified";
      const stats = diffStats(computeLineDiff(pBody, cBody));
      added = stats.added;
      removed = stats.removed;
    } else {
      status = "unchanged";
    }
    entries.push({
      evalId: id,
      evalName: c?.evalName ?? p?.evalName ?? null,
      status,
      added,
      removed,
    });
  }
  entries.sort((a, b) => a.evalId - b.evalId);
  return entries;
}

// Iteration-page roll-up of per-case body changes. Body content is
// task-specific, so the actual diff lives on the eval detail page — this
// card is a pointer index, not a content surface. Hides itself when the
// iteration has no per-case metadata.
export function CaseBodiesIndexCard({
  skillName,
  current,
  previous,
  previousIterationNumber,
}: Props) {
  if (!current || current.length === 0) return null;
  const hasPrev = previous !== null && previousIterationNumber !== null;
  const entries = buildEntries(current, previous);
  const counts = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  for (const e of entries) counts[e.status] += 1;
  const changed = entries.filter((e) => e.status !== "unchanged");
  const allUnchanged = hasPrev && changed.length === 0;
  const showChanges = hasPrev && changed.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardEyebrow>Case bodies</CardEyebrow>
        <CardTitle className="text-base">
          <span className="font-mono tabular-nums">
            {entries.length} case{entries.length === 1 ? "" : "s"}
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
            ? `Per-case body fragments. View each case for prompt content and history.`
            : allUnchanged
              ? `All case bodies identical to iteration #${previousIterationNumber}.`
              : `${changed.length} of ${entries.length} case${entries.length === 1 ? "" : "s"} body changed since iteration #${previousIterationNumber}. Click through for diffs.`}
        </p>
        {/* Diff mode shows only changed cases (unchanged would drown out the
            signal when most cases are stable). Snapshot mode shows all. */}
        <BodyList
          skillName={skillName}
          entries={hasPrev ? changed : entries}
        />
      </CardContent>
    </Card>
  );
}

function BodyList({
  skillName,
  entries,
}: {
  skillName: string;
  entries: BodyEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <ul className="border-border bg-muted/20 divide-border divide-y border font-mono text-xs">
      {entries.map((e) => (
        <BodyRow key={e.evalId} skillName={skillName} entry={e} />
      ))}
    </ul>
  );
}

function BodyRow({
  skillName,
  entry,
}: {
  skillName: string;
  entry: BodyEntry;
}) {
  const label = entry.evalName ?? `eval ${entry.evalId}`;
  const href = `/skills/${encodeURIComponent(skillName)}/evals/${entry.evalId}`;
  // Removed rows visually de-emphasize via lower opacity — they remain
  // clickable (history is still useful) but read as background context.
  const isRemoved = entry.status === "removed";
  return (
    <li>
      <Link
        href={href}
        className={cn(
          "hover:bg-muted/60 flex items-baseline gap-2 px-3 py-2 transition-colors",
          isRemoved && "opacity-60 hover:opacity-100",
        )}
      >
        <StatusGlyph status={entry.status} />
        <span className="text-muted-foreground shrink-0 tabular-nums">
          #{entry.evalId}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <RowStats
          status={entry.status}
          added={entry.added}
          removed={entry.removed}
        />
        <span aria-hidden className="text-muted-foreground shrink-0 text-[10px]">
          ↗
        </span>
      </Link>
    </li>
  );
}
