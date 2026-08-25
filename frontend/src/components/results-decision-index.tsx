import { AlertTriangle, ArrowLeft, ChevronDown, Download, MoonStar, Play } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { MoonIcon } from "@/components/moon";
import type { SessionResultsExportFormat } from "@/lib/session-results-export";
import {
  RESULTS_DECISION_FILTER_OPTIONS,
  type ResultsDecisionCounts,
  type ResultsDecisionFilter,
} from "@/lib/session-results-decision-state";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";

/** Session state shown as a status chip on the night decision index. */
export type ResultsDecisionIndexStatus =
  | { kind: "done" }
  | { kind: "running" }
  | { kind: "failed"; empty: boolean };

const INDEX_STATUS_PRESENTATION: Record<
  ResultsDecisionIndexStatus["kind"],
  { icon: typeof MoonStar; label: string; tone: string }
> = {
  running: { icon: Play, label: "Still running", tone: "text-caution-night" },
  failed: { icon: AlertTriangle, label: "Failed", tone: "text-destructive-night" },
  done: { icon: MoonStar, label: "Completed", tone: "text-night-foreground" },
};

/** Dot tint per decision filter; decision hues appear as night-readable tints. */
const RESULTS_FILTER_DOT_CLASS: Record<ResultsDecisionFilter, string> = {
  all: "bg-moonlight/80",
  pending: "bg-white/40",
  adopted: "bg-success-night",
  held: "bg-caution-night",
  rejected: "bg-destructive-night",
};

/**
 * lg+ is the desktop rail, where the review details stay permanently expanded:
 * the summary toggle only exists on the compact mobile masthead.
 */
const RESULTS_DESKTOP_RAIL_QUERY = "(min-width: 1024px)";

interface ResultsDecisionIndexProps {
  liveHref: string;
  theme: string;
  constraints: string | null;
  status: ResultsDecisionIndexStatus;
  counts: ResultsDecisionCounts;
  activeFilter: ResultsDecisionFilter;
  onSelectFilter: (filter: ResultsDecisionFilter) => void;
  onExportSessionResults: (format: SessionResultsExportFormat) => void;
  sessionResultsExportInProgress?: boolean;
  /** id of the advisory text referenced by every score badge via aria-describedby. */
  advisoryId: string;
}

/**
 * The Results decision index — the screen's one night element and its signature.
 * Desktop: a sticky rail beside the paper cluster workspace with the review
 * details (constraints, long score explanation, exports) permanently expanded.
 * Mobile: a compact masthead the height of an instrument strip — wayfinding,
 * theme, decided progress, the five decision filters, and a one-line score
 * advisory — with the review details folded into a keyboard-native "Review
 * details & export" disclosure. The advisory note sits outside (above) that
 * disclosure so its id stays rendered even while the fold is closed: every
 * LLM score badge points at it via aria-describedby. The moon waxes with the
 * decided share of ideas and tips into the waning izayoi state once every
 * idea has a decision.
 */
export function ResultsDecisionIndex({
  liveHref,
  theme,
  constraints,
  status,
  counts,
  activeFilter,
  onSelectFilter,
  onExportSessionResults,
  sessionResultsExportInProgress = false,
  advisoryId,
}: ResultsDecisionIndexProps) {
  const [reviewDetailsOpen, setReviewDetailsOpen] = useState(false);
  const isDesktopRail = useMediaQuery(RESULTS_DESKTOP_RAIL_QUERY);
  const totalIdeas = counts.all;
  const decidedCount = counts.adopted + counts.held + counts.rejected;
  const allDecided = totalIdeas > 0 && decidedCount === totalIdeas;
  const statusPresentation = INDEX_STATUS_PRESENTATION[status.kind];
  const statusLabel =
    status.kind === "failed" && !status.empty ? "Failed — partial results" : statusPresentation.label;
  const StatusIcon = statusPresentation.icon;
  const progressHeadline =
    totalIdeas === 0 ? "No ideas recorded" : `${decidedCount} / ${totalIdeas} decided`;
  const progressDetail =
    totalIdeas === 0
      ? "Nothing to triage"
      : allDecided
        ? "Every idea has a decision"
        : `${counts.pending} pending review`;

  return (
    <aside
      aria-label="Decision index"
      className="results-index responsive-sticky responsive-sticky--rail p-3 sm:p-4 lg:p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <Link to={liveHref} className="results-index__back">
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          Live view
        </Link>
        <span role="status" className={cn("live-masthead__chip shrink-0", statusPresentation.tone)}>
          <StatusIcon aria-hidden="true" className="h-3 w-3" />
          {statusLabel}
        </span>
      </div>
      <h1 className="mt-2 line-clamp-2 break-words font-display text-lg font-semibold leading-snug tracking-tight text-night-foreground sm:text-xl lg:mt-2.5 lg:line-clamp-3 lg:text-2xl">
        {theme}
      </h1>

      <div className="mt-2.5 border-t border-white/10 pt-2.5 lg:mt-4 lg:pt-4">
        <div className="flex items-center gap-2.5 lg:gap-3">
          <MoonIcon
            illumination={totalIdeas === 0 ? 0 : decidedCount / totalIdeas}
            waning={allDecided}
            className="h-8 w-8 shrink-0 text-caution-night lg:h-10 lg:w-10"
            shadeClassName="fill-white/10"
          />
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-mono text-xs leading-relaxed text-night-muted lg:block lg:gap-x-0">
            <span className="text-sm font-semibold text-night-foreground lg:block lg:text-base">
              {progressHeadline}
            </span>
            <span aria-hidden="true" className="text-white/25 lg:hidden">
              ·
            </span>
            <span>{progressDetail}</span>
          </p>
        </div>
        <div
          className="mt-3 flex flex-wrap gap-1.5 lg:mt-4"
          role="group"
          aria-label="Filter ideas by decision"
        >
          {RESULTS_DECISION_FILTER_OPTIONS.map((filterOption) => (
            <button
              key={filterOption.id}
              type="button"
              className="results-index__filter py-1 lg:w-full lg:py-1.5"
              aria-pressed={activeFilter === filterOption.id}
              onClick={() => onSelectFilter(filterOption.id)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", RESULTS_FILTER_DOT_CLASS[filterOption.id])}
                />
                <span className="truncate">{filterOption.label}</span>
              </span>
              <span className="font-mono text-xs tabular-nums">{counts[filterOption.id]}</span>
            </button>
          ))}
        </div>
        {/* Score advisory — the aria-describedby target for every LLM score
            badge. Must live outside the review details fold (directly under
            the filters) so it stays rendered while the disclosure is closed;
            exactly one element in the page may carry advisoryId. */}
        <p id={advisoryId} className="results-index__score-advisory">
          LLM scores are advisory — you make the final call.
        </p>
      </div>

      {/* Review details fold: mobile collapses constraints, the long score
          explanation, and exports behind one keyboard-native disclosure so
          triage controls own the first viewport. Desktop rail stays
          permanently expanded — forced open and the summary is removed at lg.
          Nothing in here carries the advisory id; it now lives in the visible
          note above, so closed-state score descriptions still resolve. */}
      <details
        className="group mt-2.5 rounded-md border border-white/10 bg-white/[0.04] lg:mt-4 lg:rounded-none lg:border-x-0 lg:border-b-0 lg:border-t lg:bg-transparent lg:pt-4"
        open={reviewDetailsOpen || isDesktopRail}
        onToggle={(event) => setReviewDetailsOpen(event.currentTarget.open)}
      >
        <summary className="results-index__review-summary lg:hidden">
          <MoonStar aria-hidden="true" className="h-3.5 w-3.5 text-caution-night" />
          Review details &amp; export
          <ChevronDown
            aria-hidden="true"
            className="ml-auto h-4 w-4 shrink-0 transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="space-y-2.5 px-3 pb-3 pt-1 lg:space-y-0 lg:px-0 lg:pb-0 lg:pt-0">
          {constraints && (
            <p className="line-clamp-2 text-xs leading-relaxed text-night-muted lg:mt-1.5 lg:text-sm">
              {constraints}
            </p>
          )}
          <p className="text-xs leading-relaxed text-night-muted lg:mt-3">
            Judge scores agree with human ranking only about half the time. Use them to triage,
            not to decide — your adopt/hold/reject calls and memos are the record that matters.
          </p>
          <div
            className="flex flex-wrap gap-2 lg:mt-3"
            aria-label="Export results"
            aria-busy={sessionResultsExportInProgress || undefined}
          >
            <button
              type="button"
              className="live-masthead__cta inline-flex flex-1 items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50 lg:flex-none lg:w-full"
              disabled={sessionResultsExportInProgress}
              onClick={() => onExportSessionResults("md")}
            >
              <Download aria-hidden="true" className="h-4 w-4" />
              Markdown
            </button>
            <button
              type="button"
              className="live-masthead__cta inline-flex flex-1 items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50 lg:flex-none lg:w-full"
              disabled={sessionResultsExportInProgress}
              onClick={() => onExportSessionResults("json")}
            >
              <Download aria-hidden="true" className="h-4 w-4" />
              JSON
            </button>
          </div>
        </div>
      </details>
    </aside>
  );
}
