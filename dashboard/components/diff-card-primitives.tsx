import { cn } from "@/lib/utils";

export type DiffStatus = "added" | "removed" | "modified" | "unchanged";

export const STATUS_SYMBOL: Record<DiffStatus, string> = {
  added: "+",
  removed: "−",
  modified: "~",
  unchanged: " ",
};

export const STATUS_COLOR: Record<DiffStatus, string> = {
  added: "text-emerald-600 dark:text-emerald-400",
  removed: "text-rose-600 dark:text-rose-400",
  modified: "text-amber-600 dark:text-amber-400",
  unchanged: "text-muted-foreground",
};

export const STATUS_LABEL: Record<DiffStatus, string> = {
  added: "added",
  removed: "removed",
  modified: "modified",
  unchanged: "unchanged",
};

// Diff cards expand the rows that carry "news" — a new file/template,
// content edits — and collapse the rows that carry low-signal information:
// "removed" (the content is gone, click if curious) and "unchanged" (no
// news at all). Snapshot mode (no prior iter to compare) collapses
// everything by default to keep the card scannable.
export function defaultOpenForStatus(
  status: DiffStatus,
  mode: "diff" | "snapshot",
): boolean {
  if (mode === "snapshot") return false;
  return status === "added" || status === "modified";
}

// Visually de-emphasizes removed-row summary tints so deleted content
// reads as background signal rather than primary content. Other statuses
// share one default tint.
export function summaryBgForStatus(status: DiffStatus): string {
  return status === "removed" ? "bg-muted/20" : "bg-muted/40";
}

export function ChangeSummary({
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
      <span key="add" className="text-emerald-600 dark:text-emerald-400">
        {`+${added}`}
      </span>,
    );
  }
  if (removed > 0) {
    parts.push(
      <span key="del" className="text-rose-600 dark:text-rose-400">
        {`−${removed}`}
      </span>,
    );
  }
  if (modified > 0) {
    parts.push(
      <span key="mod" className="text-amber-600 dark:text-amber-400">
        {`~${modified}`}
      </span>,
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

export function StatusGlyph({
  status,
  className,
}: {
  status: DiffStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "w-3 shrink-0 select-none font-mono",
        STATUS_COLOR[status],
        className,
      )}
    >
      {STATUS_SYMBOL[status]}
    </span>
  );
}

export function StatusLabelTag({ status }: { status: DiffStatus }) {
  return (
    <span
      className={cn(
        "text-[10px] tracking-widest uppercase",
        STATUS_COLOR[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

// Renders the "+N −M" pair used in row headers when a row is modified.
// Falls back to a status label otherwise.
export function RowStats({
  status,
  added,
  removed,
}: {
  status: DiffStatus;
  added: number;
  removed: number;
}) {
  if (status === "modified") {
    return (
      <span className="font-mono text-xs tabular-nums">
        <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{" "}
        <span className="text-rose-600 dark:text-rose-400">−{removed}</span>
      </span>
    );
  }
  return <StatusLabelTag status={status} />;
}
