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
  type DiffPart,
} from "@/components/diff-view";

type Props = {
  skillName: string;
  iterationNumber: number;
  current: string | null;
  previous: string | null;
  previousIterationNumber: number | null;
  // Override the default per-state caption. Used by the skill page to frame
  // this as a current snapshot rather than an iteration diff.
  caption?: string;
  // Optional one-liner pulled from the skill's frontmatter. Skill page passes
  // this so users immediately see what the skill is for, without expanding
  // the full snapshot.
  description?: string | null;
};

// Two distinct surfaces share this component:
//  - Iteration page (hasPrev): show the side-by-side diff inline and nothing
//    else. Full-snapshot lives one page over (the skill page) so we don't
//    repeat it here.
//  - Skill page Current source (no prev): there's nothing to diff, so we
//    render a collapsed full-snapshot view.
export function SkillMdCard({
  skillName,
  iterationNumber,
  current,
  previous,
  previousIterationNumber,
  caption,
  description,
}: Props) {
  if (!current) return null;

  const hasPrev = previous !== null && previousIterationNumber !== null;
  const unchanged = hasPrev && previous === current;
  const showDiff = hasPrev && !unchanged;

  let added = 0;
  let removed = 0;
  let parts: DiffPart[] = [];
  if (showDiff) {
    parts = computeLineDiff(previous!, current);
    const stats = diffStats(parts);
    added = stats.added;
    removed = stats.removed;
  }

  const defaultCaption = !hasPrev
    ? `Initial version — no prior iteration to compare against.`
    : unchanged
      ? `Identical to iteration #${previousIterationNumber}.`
      : `Diff from iteration #${previousIterationNumber} → #${iterationNumber}.`;

  return (
    <Card>
      <CardHeader>
        <CardEyebrow>SKILL.md</CardEyebrow>
        <CardTitle className="text-base">
          <span className="font-mono tabular-nums">
            {fmtInt(current.length)} chars
          </span>
          {showDiff ? (
            <>
              <span className="text-muted-foreground mx-2">·</span>
              <span className="font-mono tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">
                  +{added}
                </span>{" "}
                <span className="text-rose-600 dark:text-rose-400">
                  −{removed}
                </span>
              </span>{" "}
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
        {description ? (
          <p className="text-foreground text-sm leading-relaxed">{description}</p>
        ) : null}
        <p className="text-muted-foreground text-xs">{caption ?? defaultCaption}</p>

        {showDiff ? <ResponsiveDiff parts={parts} /> : null}

        {!hasPrev ? (
          <details className="group">
            <summary className="text-muted-foreground hover:text-foreground cursor-pointer font-mono text-[10px] tracking-widest uppercase select-none">
              <span className="group-open:hidden">view full snapshot ↓</span>
              <span className="hidden group-open:inline">hide full snapshot ↑</span>
            </summary>
            <pre className="bg-muted border-border mt-3 max-h-96 overflow-auto border px-3 py-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {current}
            </pre>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
