import { MoonIcon } from "@/components/moon";
import {
  SESSION_LIVE_PHASE_SEQUENCE,
  type SessionLivePhase,
} from "@/lib/session-live-phase";
import { cn } from "@/lib/utils";

const SESSION_LIVE_PHASE_PRESENTATION: Record<
  SessionLivePhase,
  { label: string; illumination: number; waning: boolean }
> = {
  framing: { label: "Framing", illumination: 0.2, waning: false },
  divergence: { label: "Independent divergence", illumination: 0.45, waning: false },
  discussion: { label: "Discussion", illumination: 0.7, waning: false },
  convergence: { label: "Convergence", illumination: 1, waning: false },
  done: { label: "Sixteenth night", illumination: 1, waning: true },
};

/** Returns the visible and announced label for one canonical Live phase. */
export function getSessionLivePhaseLabel(phase: SessionLivePhase): string {
  return SESSION_LIVE_PHASE_PRESENTATION[phase].label;
}

/** Rendering state for the current phase, including load and terminal-error announcements. */
export type SessionLivePhaseStatus = "loading" | "active" | "failed";

type SessionLivePhasePresentationState = "complete" | "current" | "reached" | "upcoming";

function getSessionLivePhasePresentationState({
  currentIndex,
  index,
  status,
}: {
  currentIndex: number;
  index: number;
  status: SessionLivePhaseStatus;
}): SessionLivePhasePresentationState {
  if (currentIndex < 0) return "upcoming";
  if (status === "failed") {
    if (index < currentIndex) return "complete";
    return index === currentIndex ? "reached" : "upcoming";
  }
  if (index < currentIndex) return "complete";
  return index === currentIndex ? "current" : "upcoming";
}

/**
 * Session progress as a lunar cycle: the moon waxes through the four working
 * phases and the session closes under the izayoi (sixteenth-night) moon.
 * Rendered on the night masthead — the phase position IS the progress meter.
 */
export function PhaseStepper({
  current,
  status,
}: {
  current: SessionLivePhase | null;
  status: SessionLivePhaseStatus;
}) {
  const currentIndex = current === null ? -1 : SESSION_LIVE_PHASE_SEQUENCE.indexOf(current);
  const currentLabel = current === null ? null : getSessionLivePhaseLabel(current);
  const phaseAnnouncement =
    status === "loading"
      ? "Loading current session phase."
      : status === "failed"
        ? currentLabel === null
          ? "Session ended with an error; the last phase is unavailable."
          : `Session ended with an error after reaching ${currentLabel}.`
        : currentLabel === null
          ? "Current session phase is unavailable."
          : `Current phase: ${currentLabel}.`;

  return (
    <>
      <ol
        aria-label="Session phases"
        aria-busy={status === "loading" || undefined}
        className="flex items-start justify-between gap-1 sm:gap-2"
      >
        {SESSION_LIVE_PHASE_SEQUENCE.map((phase, index) => {
          const presentation = SESSION_LIVE_PHASE_PRESENTATION[phase];
          const state = getSessionLivePhasePresentationState({ currentIndex, index, status });
          return (
            <li
              key={phase}
              aria-current={state === "current" ? "step" : undefined}
              className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
            >
              <div aria-hidden="true" className="flex w-full items-center">
                <div
                  className={cn(
                    "h-px flex-1",
                    index === 0
                      ? "bg-transparent"
                      : state === "upcoming"
                        ? "bg-white/10"
                        : "bg-white/30"
                  )}
                />
                <MoonIcon
                  illumination={presentation.illumination}
                  waning={presentation.waning}
                  glow={state === "current"}
                  shadeClassName="fill-night"
                  className={cn(
                    "h-6 w-6 shrink-0 transition-colors sm:h-7 sm:w-7",
                    state === "complete" && "text-night-foreground/85",
                    state === "current" && "text-night-foreground",
                    state === "reached" && "text-destructive-night",
                    state === "upcoming" && "text-night-muted/50"
                  )}
                />
                <div
                  className={cn(
                    "h-px flex-1",
                    index === SESSION_LIVE_PHASE_SEQUENCE.length - 1
                      ? "bg-transparent"
                      : index < currentIndex
                        ? "bg-white/30"
                        : "bg-white/10"
                  )}
                />
              </div>
              <span
                className={cn(
                  "max-w-full truncate text-center text-[10px] leading-tight sm:text-xs",
                  state === "current" &&
                    "rounded bg-white/10 px-1.5 py-0.5 font-semibold text-night-foreground",
                  state === "reached" && "font-medium text-destructive-night",
                  state === "complete" && "text-night-muted",
                  state === "upcoming" && "text-night-muted/60"
                )}
              >
                {presentation.label}
                <span className="sr-only">
                  {state === "complete"
                    ? ", completed"
                    : state === "reached"
                      ? ", reached before the session error"
                      : state === "upcoming"
                        ? ", upcoming"
                        : ""}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {phaseAnnouncement}
      </p>
    </>
  );
}
