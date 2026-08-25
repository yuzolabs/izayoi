import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import type {
  ResultsDecisionCluster,
  ResultsDecisionFilter,
} from "@/lib/session-results-decision-state";
import { getSessionResultsClusterHeaderId } from "@/lib/use-session-results-focus-recovery";
import { cn } from "@/lib/utils";

interface ResultsClusterDossierProps {
  cluster: ResultsDecisionCluster;
  expanded: boolean;
  onToggle: () => void;
  activeFilter: ResultsDecisionFilter;
  /** Idea cards, rendered by the caller so save-state wiring stays in the view. */
  children: ReactNode;
}

/** Stable DOM id fragment for one cluster's disclosure target. */
function getResultsClusterDomKey(clusterId: number | null): string {
  return clusterId === null ? "unclustered" : String(clusterId).replace("-", "negative-");
}

/**
 * One Results cluster as a scannable dossier: a brass disclosure strip
 * (mono cluster number + synthesized excerpt + match/total count) above the
 * white idea cards, so cluster navigation and idea decisions read as two
 * separate hierarchy levels instead of one flat card column.
 */
export function ResultsClusterDossier({
  cluster,
  expanded,
  onToggle,
  activeFilter,
  children,
}: ResultsClusterDossierProps) {
  const domKey = getResultsClusterDomKey(cluster.id);
  const contentId = `results-cluster-${domKey}-content`;
  const headerId = getSessionResultsClusterHeaderId(cluster.key);
  const clusterLabel = cluster.id === null ? "Not yet clustered" : `Cluster #${cluster.id}`;
  const headerTitle = cluster.synthesized ?? clusterLabel;
  const countText =
    activeFilter === "all"
      ? `${cluster.totalIdeaCount} ${cluster.totalIdeaCount === 1 ? "idea" : "ideas"}`
      : `${cluster.matchingIdeaCount} of ${cluster.totalIdeaCount} match`;

  return (
    <section
      aria-label={clusterLabel}
      className="min-w-0"
      data-session-results-focus-region="cluster"
    >
      <button
        id={headerId}
        type="button"
        className="results-dossier__header"
        data-session-results-cluster-header
        aria-expanded={expanded}
        aria-controls={contentId}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${clusterLabel} — ${countText}`}
        onClick={onToggle}
      >
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-sm font-semibold text-primary"
        >
          #{cluster.id ?? "—"}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {headerTitle}
        </span>
        <span className="shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground">
          {countText}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180"
          )}
        />
      </button>
      <div id={contentId} hidden={!expanded} className="mt-2 min-w-0 space-y-2.5 lg:mt-2.5 lg:space-y-3">
        {cluster.synthesized && (
          <div className="rounded-md border border-border bg-muted/70 p-2.5 lg:p-3">
            <p className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Synthesized by the facilitator
            </p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {cluster.synthesized}
            </p>
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
