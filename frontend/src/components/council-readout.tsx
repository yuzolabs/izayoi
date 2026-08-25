import { TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Mono "instrument readout" of the session plan: personas, ideas, rounds,
 * judge, estimated LLM calls. Lives on the night chrome, announces changes
 * politely to screen readers, and carries the >=10-agents cost warning in
 * both variants (color is never the only signal — the text says it too).
 */
export function CouncilReadout({
  variant,
  personaCount,
  ideasPerAgent,
  discussionRounds,
  enableJudge,
  estimatedCalls,
  minimumMet,
}: {
  variant: "rail" | "bar";
  personaCount: number;
  ideasPerAgent: number;
  discussionRounds: number;
  enableJudge: boolean;
  estimatedCalls: number;
  /** true when personaCount >= 2 (the council minimum). */
  minimumMet: boolean;
}) {
  const costWarning = personaCount >= 10;

  if (variant === "bar") {
    return (
      <div className="council-readout flex flex-wrap items-center gap-x-2 gap-y-1" aria-live="polite">
        <span className={cn(minimumMet ? "council-readout__value" : undefined)}>
          {personaCount} {personaCount === 1 ? "persona" : "personas"}
        </span>
        <span aria-hidden="true">·</span>
        <span>{ideasPerAgent} ideas each</span>
        <span aria-hidden="true">·</span>
        <span>{discussionRounds} rounds</span>
        <span aria-hidden="true">·</span>
        <span className="council-readout__value">~{estimatedCalls} calls</span>
        {costWarning && (
          <span className="flex items-center gap-1 font-medium text-caution-night">
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
            expensive council
          </span>
        )}
      </div>
    );
  }

  const rows: Array<[string, string]> = [
    ["personas", `${personaCount} of 16`],
    ["ideas", `${personaCount * ideasPerAgent}`],
    ["discussion rounds", `${discussionRounds}`],
    ["llm judge", enableJudge ? "on" : "off"],
    ["est. calls", `~${estimatedCalls}`],
  ];

  return (
    <div className="council-readout space-y-2" aria-live="polite">
      <p className="council-readout__title">Session plan</p>
      <dl className="space-y-1">
        {rows.map(([term, value]) => (
          <div key={term} className="flex items-baseline justify-between gap-3">
            <dt>{term}</dt>
            <dd className="council-readout__value">{value}</dd>
          </div>
        ))}
      </dl>
      {costWarning && (
        <p className="flex items-start gap-1.5 font-medium text-caution-night">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Cost warning: an expensive council. Consider a balanced quartet.
        </p>
      )}
    </div>
  );
}
