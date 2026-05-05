import Link from "next/link";
import { getPortfolioStats, listSkills } from "@/lib/queries";
import { fmtInt, fmtPct, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardEyebrow,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  const [stats, skills] = await Promise.all([
    getPortfolioStats(),
    listSkills(),
  ]);

  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <p className="text-muted-foreground font-mono text-[10px] tracking-[0.2em] uppercase">
          better-skills · eval trajectory archive
        </p>
        <h1 className="font-heading max-w-3xl text-4xl leading-[1.05] tracking-tight md:text-5xl">
          Every iteration on every skill, recorded and compared.
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
          Each row below is a skill under active revision. Pass rates are
          measured with and without the skill prompt attached; the delta is the
          measurement the dashboard exists to track.
        </p>
      </section>

      <KpiStrip stats={stats} />

      {skills.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="space-y-4">
          <header className="border-border flex items-baseline justify-between border-b pb-3">
            <h2 className="font-heading text-xl tracking-tight">
              Skills under measurement
            </h2>
            <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
              {skills.length} total · sorted by recent activity
            </span>
          </header>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {skills.map((s) => (
              <SkillCard key={s.name} skill={s} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function KpiStrip({
  stats,
}: {
  stats: Awaited<ReturnType<typeof getPortfolioStats>>;
}) {
  const items = [
    { label: "Skills tracked", value: fmtInt(stats.skillsCount) },
    { label: "Iterations logged", value: fmtInt(stats.iterationsCount) },
    { label: "Benchmark runs", value: fmtInt(stats.runsCount) },
    { label: "Last upload", value: fmtRelative(stats.latestUpload) },
  ];
  return (
    <section className="border-border grid grid-cols-2 border md:grid-cols-4">
      {items.map((it, i) => (
        <div
          key={it.label}
          className={cn(
            "px-5 py-4",
            // mobile (2-col): bottom border on the top row only (first 2 items)
            i < 2 && "border-border border-b md:border-b-0",
            // desktop (4-col): right border on all but the last
            i < items.length - 1 && "md:border-border md:border-r",
          )}
        >
          <div className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
            {it.label}
          </div>
          <div className="font-mono mt-1 text-2xl font-medium tabular-nums">
            {it.value}
          </div>
        </div>
      ))}
    </section>
  );
}

function SkillCard({
  skill,
}: {
  skill: Awaited<ReturnType<typeof listSkills>>[number];
}) {
  const href = `/skills/${encodeURIComponent(skill.name)}`;
  return (
    <Link
      href={href}
      className="group block transition-transform active:scale-[0.99]"
    >
      <Card className="group-hover:bg-muted/40 h-full transition-colors">
        <CardHeader>
          <CardEyebrow>
            iteration ·{" "}
            <span className="font-mono tabular-nums">
              #{skill.latestIterationNumber ?? "—"}
            </span>
          </CardEyebrow>
          <CardTitle className="group-hover:underline decoration-1 underline-offset-4">
            {skill.name}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-4xl font-medium tabular-nums">
              {fmtPct(skill.latestPassRate, 1)}
            </span>
            <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
              current pass rate
            </span>
          </div>
        </CardContent>
        <CardFooter>
          <span>{skill.iterationsCount} iter</span>
          <span>{fmtRelative(skill.updatedAt)}</span>
        </CardFooter>
      </Card>
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="border-border text-muted-foreground flex min-h-64 flex-col items-center justify-center gap-3 border border-dashed px-6 py-12 text-center">
      <div className="font-mono text-[10px] tracking-widest uppercase">
        No skills uploaded yet
      </div>
      <p className="max-w-md text-sm leading-relaxed">
        Run{" "}
        <code className="bg-muted px-1 py-0.5 text-xs">
          scripts/aggregate_benchmark.py
        </code>{" "}
        with{" "}
        <code className="bg-muted px-1 py-0.5 text-xs">
          SKILL_DASHBOARD_URL
        </code>{" "}
        and{" "}
        <code className="bg-muted px-1 py-0.5 text-xs">
          SKILL_DASHBOARD_TOKEN
        </code>{" "}
        set in the environment, and the dashboard will populate as benchmarks
        complete.
      </p>
      <p
        className="text-muted-foreground/60 font-mono text-[10px] tracking-widest uppercase"
        aria-hidden
      >
        {"// awaiting first ingest"}
      </p>
    </div>
  );
}

