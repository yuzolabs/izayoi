import { useId } from "react";

import { cn } from "@/lib/utils";

/**
 * The izayoi moon motif. "Izayoi" is the moon of the sixteenth night — just
 * past full, hesitating at the start of its wane. Each brainstorming phase
 * maps to a lunar phase; the session completes under the sixteenth-night moon.
 */
export function MoonIcon({
  illumination,
  waning = false,
  className,
  glow = false,
}: {
  /** 0 = new moon, 1 = full moon. */
  illumination: number;
  /** Slightly past full: shadow creeps in from the left (the izayoi state). */
  waning?: boolean;
  className?: string;
  glow?: boolean;
}) {
  const clipId = useId();
  const k = Math.max(0, Math.min(1, illumination));
  // Lit disc slides in from the right as the moon waxes; for the waning
  // izayoi moon it slides a touch past center, shadowing the left limb.
  const litCx = waning ? 12 - 2.2 : 12 + (1 - k) * 20;
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("inline-block", glow && "animate-moon-glow", className)}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="12" cy="12" r="8.5" />
        </clipPath>
      </defs>
      <circle cx="12" cy="12" r="8.5" className="fill-secondary" />
      <g clipPath={`url(#${clipId})`}>
        <circle cx={litCx} cy="12" r="8.5" fill="currentColor" />
      </g>
      <circle
        cx="12"
        cy="12"
        r="8.5"
        fill="none"
        className="stroke-border"
        strokeWidth="1"
      />
    </svg>
  );
}

/** Brand mark: the sixteenth-night moon. */
export function MoonLogo({ className }: { className?: string }) {
  return <MoonIcon illumination={1} waning className={cn("text-primary", className)} />;
}
