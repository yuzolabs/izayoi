import {
  AlertTriangle,
  ArrowRight,
  LoaderCircle,
  MoonStar,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { LiveMetricsReadout } from "@/components/live-metrics-readout";
import { PhaseStepper } from "@/components/phase-stepper";
import type { Session, SessionMetrics, SessionStreamConnectionState } from "@/lib/api";
import type { SessionLivePhase } from "@/lib/session-live-phase";
import { cn } from "@/lib/utils";

/** Load lifecycle of the Live session view, shared by masthead and view body. */
export type SessionLiveLoadState = "loading" | "ready" | "failed";

const MASTHEAD_STATUS_PRESENTATION = {
  loading: { icon: LoaderCircle, label: "Loading session", tone: "text-night-muted", spin: true },
  failed: { icon: AlertTriangle, label: "Session error", tone: "text-destructive-night", spin: false },
  done: { icon: MoonStar, label: "Done", tone: "text-night-foreground", spin: false },
  connecting: { icon: LoaderCircle, label: "Connecting", tone: "text-night-muted", spin: true },
  reconnecting: { icon: RefreshCw, label: "Reconnecting", tone: "text-caution-night", spin: true },
  disconnected: { icon: WifiOff, label: "Disconnected", tone: "text-destructive-night", spin: false },
  complete: { icon: MoonStar, label: "Stream complete", tone: "text-night-muted", spin: false },
  live: { icon: MoonStar, label: "Live", tone: "text-night-foreground", spin: false },
} as const;

/** Status chip on the night masthead: icon + text for every observable state. */
export function LiveMastheadStatusChip({
  loadState,
  phase,
  connectionState,
  hasError,
}: {
  loadState: SessionLiveLoadState;
  phase: SessionLivePhase | null;
  connectionState: SessionStreamConnectionState;
  hasError: boolean;
}) {
  let presentation: (typeof MASTHEAD_STATUS_PRESENTATION)[keyof typeof MASTHEAD_STATUS_PRESENTATION];
  if (loadState === "loading") presentation = MASTHEAD_STATUS_PRESENTATION.loading;
  else if (hasError || loadState === "failed")
    presentation = MASTHEAD_STATUS_PRESENTATION.failed;
  else if (phase === "done") presentation = MASTHEAD_STATUS_PRESENTATION.done;
  else if (connectionState === "connecting")
    presentation = MASTHEAD_STATUS_PRESENTATION.connecting;
  else if (connectionState === "reconnecting")
    presentation = MASTHEAD_STATUS_PRESENTATION.reconnecting;
  else if (connectionState === "disconnected")
    presentation = MASTHEAD_STATUS_PRESENTATION.disconnected;
  else if (connectionState === "complete")
    presentation = MASTHEAD_STATUS_PRESENTATION.complete;
  else presentation = MASTHEAD_STATUS_PRESENTATION.live;

  const StatusIcon = presentation.icon;
  const isLive = presentation === MASTHEAD_STATUS_PRESENTATION.live;

  return (
    <span role="status" aria-live="polite" className={cn("live-masthead__chip", presentation.tone)}>
      {isLive ? (
        <span aria-hidden="true" className="live-pulse-dot relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-night-foreground" />
        </span>
      ) : (
        <StatusIcon aria-hidden="true" className={cn("h-3 w-3", presentation.spin && "animate-spin")} />
      )}
      {presentation.label}
    </span>
  );
}

/**
 * The Live observatory's night masthead — the screen's single night element.
 * Row 1: status chip + Results CTA beside the Fraunces theme. Row 2: the lunar
 * phase rail. Row 3 (when metrics exist): the compressed mono instrument line.
 * Sticky on desktop so phase and status stay in view while the council works.
 */
export function LiveMasthead({
  session,
  loadState,
  phase,
  phaseStatus,
  connectionState,
  hasError,
  metrics,
  resultsHref,
  resultsEmphasized,
}: {
  session: Session | null;
  loadState: SessionLiveLoadState;
  phase: SessionLivePhase | null;
  phaseStatus: "loading" | "active" | "failed";
  connectionState: SessionStreamConnectionState;
  hasError: boolean;
  metrics: SessionMetrics | null;
  resultsHref: string;
  /** true once the session finished — promotes the Results CTA to brass. */
  resultsEmphasized: boolean;
}) {
  let heading: ReactNode;
  if (loadState === "loading") {
    heading = <span className="sr-only">Loading session</span>;
  } else if (session === null) {
    heading = "Session";
  } else {
    heading = session.theme;
  }

  return (
    <header className="live-masthead responsive-sticky responsive-sticky--masthead p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <LiveMastheadStatusChip
            loadState={loadState}
            phase={phase}
            connectionState={connectionState}
            hasError={hasError}
          />
          <h1 className="mt-2 line-clamp-2 font-display text-xl font-semibold tracking-tight text-night-foreground sm:text-2xl">
            {heading}
          </h1>
          {session?.constraints && (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-night-muted sm:text-sm">
              {session.constraints}
            </p>
          )}
        </div>
        <Link
          to={resultsHref}
          className={cn(
            "inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-night",
            resultsEmphasized
              ? "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
              : "border border-white/25 bg-white/10 text-night-foreground hover:bg-white/20"
          )}
        >
          Results
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      </div>
      <div className="mt-4 border-t border-white/10 pt-3.5">
        <PhaseStepper current={phase} status={phaseStatus} />
      </div>
      {metrics && (
        <div className="mt-3 border-t border-white/10 pt-3">
          <LiveMetricsReadout metrics={metrics} />
        </div>
      )}
    </header>
  );
}
