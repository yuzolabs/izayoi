import { MoonStar } from "lucide-react";

import { PersonaBadge } from "@/components/persona-badge";
import { ScoreBadges } from "@/components/score-badge";
import { Badge } from "@/components/ui/badge";
import type { Idea } from "@/lib/api";

/**
 * Confirmed ideas as an open ledger on paper (no card chrome — visually
 * distinct from the agent workbenches and the discussion log). New rows
 * arrive via aria-live additions; the mono index keeps count scannable.
 */
export function ConfirmedIdeasLedger({ ideas }: { ideas: readonly Idea[] }) {
  return (
    <section aria-labelledby="confirmed-ideas-heading" className="min-w-0">
      <div className="flex items-baseline gap-2.5 border-b border-border pb-3">
        <h2
          id="confirmed-ideas-heading"
          className="font-display text-lg font-semibold tracking-tight"
        >
          Confirmed ideas
        </h2>
        <span className="font-mono text-sm font-semibold text-primary">
          {String(ideas.length).padStart(2, "0")}
        </span>
        <span className="ml-auto hidden pl-4 text-right text-xs text-muted-foreground sm:block">
          locked in as each pass completes
        </span>
      </div>
      <div
        aria-live="polite"
        aria-relevant="additions text"
        className="max-h-96 divide-y divide-border overflow-y-auto"
      >
        {ideas.length === 0 && (
          <div role="status" className="flex items-start gap-2 py-4 text-sm text-muted-foreground">
            <MoonStar aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p>Ideas land here the moment each persona finishes its independent pass.</p>
          </div>
        )}
        {ideas.map((idea, index) => (
          <article key={idea.id} className="animate-fade-in flex gap-3 py-3">
            <span
              aria-hidden="true"
              className="pt-0.5 font-mono text-xs font-semibold text-primary"
            >
              {String(index + 1).padStart(2, "0")}
            </span>
            <div className="min-w-0">
              <p className="text-sm leading-relaxed">{idea.content}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <PersonaBadge type={idea.persona_type} />
                <Badge variant="outline" className="font-normal">
                  {idea.phase === "divergence" ? "Independent" : "Discussion"}
                </Badge>
                {idea.cluster_id !== null && (
                  <Badge variant="outline" className="font-mono font-normal">
                    #{idea.cluster_id}
                  </Badge>
                )}
                {idea.scores && <ScoreBadges scores={idea.scores} />}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
