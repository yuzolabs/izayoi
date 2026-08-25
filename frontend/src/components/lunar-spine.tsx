import type { ReactNode } from "react";

import { MoonIcon } from "@/components/moon";
import { cn } from "@/lib/utils";

/**
 * The lunar spine — izayoi's signature navigation element.
 * Steps are rendered as waxing moons on the night sky: the phase position
 * IS the progress information (crescent → half → gibbous → full). The
 * current step carries aria-current="step".
 *
 * variant="rail": full-height night column for desktop (session readout and
 * the start action live in the same band, passed as children).
 * variant="strip": compact horizontal strip for mobile, sticky under the
 * app header.
 */
export interface SpineStep {
  /** DOM id of the section this step scrolls to. */
  id: string;
  label: string;
  /** 0 = new moon … 1 = full moon; encodes how far along the setup is. */
  illumination: number;
  waning?: boolean;
}

export function LunarSpine({
  variant,
  steps,
  activeId,
  onSelect,
  children,
  className,
}: {
  variant: "rail" | "strip";
  steps: SpineStep[];
  activeId: string;
  onSelect: (id: string) => void;
  /** rail only: readout + action slot pinned below the steps. */
  children?: ReactNode;
  className?: string;
}) {
  const moonClassName = "shrink-0 text-night-foreground";

  if (variant === "strip") {
    return (
      <nav
        aria-label="Setup steps"
        className={cn("lunar-spine flex items-center gap-1 p-1.5", className)}
      >
        {steps.map((step, index) => (
          <button
            key={step.id}
            type="button"
            aria-current={step.id === activeId ? "step" : undefined}
            onClick={() => onSelect(step.id)}
            className={cn(
              "lunar-spine__step min-w-0 flex-1 justify-center gap-1.5 px-1.5 py-1.5 text-xs"
            )}
          >
            <MoonIcon
              illumination={step.illumination}
              waning={step.waning}
              shadeClassName="fill-night"
              className={cn("h-4 w-4", moonClassName)}
            />
            <span className="min-w-0 truncate">{step.label}</span>
            <span className="sr-only">— step {index + 1} of {steps.length}</span>
          </button>
        ))}
      </nav>
    );
  }

  return (
    <aside className={cn("lunar-spine flex flex-col p-3", className)}>
      <p className="council-readout__title px-2.5 pb-2 pt-1">
        Council setup
      </p>
      <nav aria-label="Setup steps" className="flex flex-col gap-0.5">
        {steps.map((step, index) => (
          <button
            key={step.id}
            type="button"
            aria-current={step.id === activeId ? "step" : undefined}
            onClick={() => onSelect(step.id)}
            className="lunar-spine__step"
          >
            <MoonIcon
              illumination={step.illumination}
              waning={step.waning}
              shadeClassName="fill-night"
              className={cn("h-5 w-5", moonClassName)}
            />
            <span className="font-mono text-[0.7rem] text-night-muted">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span>{step.label}</span>
          </button>
        ))}
      </nav>
      <div className="mt-auto space-y-3 border-t border-white/10 px-2.5 pb-1.5 pt-3">
        {children}
      </div>
    </aside>
  );
}
