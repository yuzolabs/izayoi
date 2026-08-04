import type { IdeaScores } from "@/lib/api";
import { cn } from "@/lib/utils";

const AXES = [
  { key: "novelty", label: "N" },
  { key: "feasibility", label: "F" },
  { key: "clarity", label: "C" },
] as const;

export function ScoreBadges({ scores }: { scores: IdeaScores }) {
  return (
    <span className="inline-flex items-center gap-1" title={`Total ${scores.total} / 30`}>
      {AXES.map((axis) => (
        <span
          key={axis.key}
          className={cn(
            "inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 font-mono text-[11px]",
            scores[axis.key] >= 7
              ? "border-success/40 bg-success/10 text-success"
              : scores[axis.key] >= 4
                ? "border-border bg-secondary text-secondary-foreground"
                : "border-caution/40 bg-caution/10 text-caution"
          )}
        >
          <span className="font-sans">{axis.label}</span>
          {scores[axis.key]}
        </span>
      ))}
      <span className="ml-0.5 font-mono text-[11px] text-muted-foreground">Σ{scores.total}</span>
    </span>
  );
}
