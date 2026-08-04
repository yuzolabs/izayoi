import { MoonIcon } from "@/components/moon";
import { cn } from "@/lib/utils";

export const PHASES = [
  { id: "framing", label: "Framing", illumination: 0.2, waning: false },
  { id: "divergence", label: "Independent divergence", illumination: 0.45, waning: false },
  { id: "discussion", label: "Discussion", illumination: 0.7, waning: false },
  { id: "convergence", label: "Convergence", illumination: 1, waning: false },
  { id: "done", label: "Sixteenth night", illumination: 1, waning: true },
] as const;

export type PhaseId = (typeof PHASES)[number]["id"];

/**
 * Session progress as a lunar cycle: the moon waxes through the four working
 * phases and the session closes under the izayoi (sixteenth-night) moon.
 */
export function PhaseStepper({ current }: { current: string }) {
  const currentIndex = Math.max(
    0,
    PHASES.findIndex((p) => p.id === current)
  );
  return (
    <ol className="flex items-start justify-between gap-1 sm:gap-2">
      {PHASES.map((phase, index) => {
        const state =
          index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming";
        return (
          <li key={phase.id} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <div className="flex w-full items-center">
              <div
                className={cn(
                  "h-px flex-1",
                  index === 0 ? "bg-transparent" : state === "upcoming" ? "bg-border" : "bg-primary/50"
                )}
              />
              <MoonIcon
                illumination={phase.illumination}
                waning={phase.waning}
                glow={state === "current"}
                className={cn(
                  "h-7 w-7 shrink-0 transition-colors",
                  state === "complete" && "text-primary",
                  state === "current" && "text-primary",
                  state === "upcoming" && "text-muted-foreground/40"
                )}
              />
              <div
                className={cn(
                  "h-px flex-1",
                  index === PHASES.length - 1
                    ? "bg-transparent"
                    : index < currentIndex
                      ? "bg-primary/50"
                      : "bg-border"
                )}
              />
            </div>
            <span
              className={cn(
                "truncate text-center text-[11px] leading-tight sm:text-xs",
                state === "current" ? "font-medium text-foreground" : "text-muted-foreground"
              )}
            >
              {phase.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
