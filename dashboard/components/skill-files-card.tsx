import Link from "next/link";
import {
  Card,
  CardContent,
  CardEyebrow,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { fmtInt } from "@/lib/format";
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
import { cn } from "@/lib/utils";

type Props = {
  skillName: string;
  current: Record<string, string> | null;
  previous: Record<string, string> | null;
  previousIterationNumber: number | null;
  // Override the default per-state caption. Used by the skill page to frame
  // this as a current snapshot rather than an iteration diff.
  caption?: string;
};

type FileEntry = {
  path: string;
  status: DiffStatus;
  current: string | null;
  previous: string | null;
  added: number;
  removed: number;
  bytes: number;
};

function buildEntries(
  current: Record<string, string>,
  previous: Record<string, string> | null,
): FileEntry[] {
  const prev = previous ?? {};
  const allPaths = new Set([...Object.keys(current), ...Object.keys(prev)]);
  const entries: FileEntry[] = [];
  for (const path of allPaths) {
    const c = path in current ? current[path] : null;
    const p = path in prev ? prev[path] : null;
    let status: DiffStatus;
    let added = 0;
    let removed = 0;
    if (c !== null && p === null) {
      status = "added";
    } else if (c === null && p !== null) {
      status = "removed";
    } else if (c !== null && p !== null && c !== p) {
      status = "modified";
      const stats = diffStats(computeLineDiff(p, c));
      added = stats.added;
      removed = stats.removed;
    } else {
      status = "unchanged";
    }
    entries.push({
      path,
      status,
      current: c,
      previous: p,
      added,
      removed,
      bytes: (c ?? p ?? "").length,
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

// Two distinct surfaces share this component:
//  - Iteration page (hasPrev): only changed files are listed; modified/added
//    files expand by default while removed files collapse (their content is
//    gone — low-signal until the user asks).
//  - Skill page Current source (no prev): file tree with full-content
//    expand. The "view full" affordance lives here exclusively.
export function SkillFilesCard({
  skillName,
  current,
  previous,
  previousIterationNumber,
  caption,
}: Props) {
  if (!current || Object.keys(current).length === 0) return null;

  const hasPrev = previous !== null && previousIterationNumber !== null;
  const entries = buildEntries(current, previous);

  const counts = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  for (const e of entries) counts[e.status] += 1;

  const changedEntries = entries.filter((e) => e.status !== "unchanged");
  const allUnchanged = hasPrev && changedEntries.length === 0;
  const showChanges = hasPrev && changedEntries.length > 0;

  // Total chars across files that exist in this iteration (excludes removed,
  // which only existed in the prior).
  const totalBytes = entries
    .filter((e) => e.status !== "removed")
    .reduce((sum, e) => sum + e.bytes, 0);

  const defaultCaption = !hasPrev
    ? `Initial snapshot — no prior iteration to compare against.`
    : allUnchanged
      ? `Identical to iteration #${previousIterationNumber}.`
      : `${changedEntries.length} of ${entries.length} files changed since iteration #${previousIterationNumber}.`;

  return (
    <Card>
      <CardHeader>
        <CardEyebrow>Skill files</CardEyebrow>
        <CardTitle className="text-base">
          <span className="font-mono tabular-nums">
            {Object.keys(current).length} files
          </span>
          <span className="text-muted-foreground mx-2">·</span>
          <span className="text-muted-foreground font-mono text-xs font-normal tabular-nums">
            {fmtInt(totalBytes)} chars
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
        <p className="text-muted-foreground text-xs">{caption ?? defaultCaption}</p>

        {showChanges ? <ChangedFileList entries={changedEntries} /> : null}

        {/* Snapshot mode (skill page): collapsed file tree with full-content expand. */}
        {!hasPrev ? <SnapshotFileList entries={entries} /> : null}
      </CardContent>
    </Card>
  );
}

function ChangedFileList({ entries }: { entries: FileEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="space-y-3">
      {entries.map((e) => (
        <ChangedFileRow key={e.path} entry={e} />
      ))}
    </div>
  );
}

function ChangedFileRow({ entry }: { entry: FileEntry }) {
  return (
    <details
      className="border-border group/file border"
      open={defaultOpenForStatus(entry.status, "diff")}
    >
      <summary
        className={cn(
          "hover:bg-muted/60 flex cursor-pointer items-baseline gap-2 px-3 py-2",
          "list-none [&::-webkit-details-marker]:hidden",
          summaryBgForStatus(entry.status),
        )}
      >
        <span
          aria-hidden
          className="text-muted-foreground w-3 shrink-0 transition-transform group-open/file:rotate-90"
        >
          ›
        </span>
        <StatusGlyph status={entry.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {entry.path}
        </span>
        <RowStats
          status={entry.status}
          added={entry.added}
          removed={entry.removed}
        />
      </summary>
      <ChangedFileBody entry={entry} />
    </details>
  );
}

function ChangedFileBody({ entry }: { entry: FileEntry }) {
  if (entry.status === "modified" && entry.previous !== null && entry.current !== null) {
    const parts = computeLineDiff(entry.previous, entry.current);
    return <ResponsiveDiff parts={parts} className="border-x-0 border-b-0 border-t" />;
  }
  // added or removed: full content single-column.
  const content = entry.status === "removed" ? entry.previous : entry.current;
  if (!content) return null;
  return (
    <pre
      className={cn(
        "bg-muted border-border max-h-[28rem] overflow-auto border-t px-3 py-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap",
        entry.status === "added" &&
          "bg-emerald-500/5 text-emerald-900 dark:text-emerald-100",
        entry.status === "removed" &&
          "bg-rose-500/5 text-rose-900 dark:text-rose-100",
      )}
    >
      {content}
    </pre>
  );
}

// Skill-page snapshot list: flat tree of all files, each row collapsible to
// reveal full content. No diff signals (there's no prior to compare).
function SnapshotFileList({ entries }: { entries: FileEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="border-border bg-muted/30 mt-3 border font-mono text-[11px]">
      {entries.map((e) => (
        <SnapshotFileRow key={e.path} entry={e} />
      ))}
    </div>
  );
}

function SnapshotFileRow({ entry }: { entry: FileEntry }) {
  return (
    <details className="group/file border-border border-b last:border-b-0">
      <summary
        className={cn(
          "hover:bg-muted/50 flex cursor-pointer items-baseline gap-2 px-3 py-1",
          "list-none [&::-webkit-details-marker]:hidden",
        )}
      >
        <span
          aria-hidden
          className="text-muted-foreground w-3 shrink-0 transition-transform group-open/file:rotate-90"
        >
          ›
        </span>
        <span className="min-w-0 flex-1 truncate">{entry.path}</span>
        <span className="text-muted-foreground shrink-0 tabular-nums">
          {fmtInt(entry.bytes)}
        </span>
      </summary>
      {entry.current !== null ? (
        <pre className="bg-muted border-border max-h-96 overflow-auto border-t px-3 py-3 text-[11px] leading-relaxed whitespace-pre-wrap">
          {entry.current}
        </pre>
      ) : null}
    </details>
  );
}
