import { TriangleAlert } from "lucide-react";

import type { SessionMetrics } from "@/lib/api";

/**
 * Live diversity metrics compressed into one mono instrument line on the
 * night masthead (values bright, labels muted). The collapse warning stays
 * a role="alert" in caution-night — icon + text, color is never the only signal.
 */
export function LiveMetricsReadout({ metrics }: { metrics: SessionMetrics }) {
  return (
    <div
      role="group"
      aria-label="Council diversity metrics"
      className="live-metrics-readout"
    >
      <p className="sr-only">
        {`${metrics.total_ideas} ideas, ${metrics.unique_ideas} unique, non-duplicate ratio ${metrics.non_duplicate_ratio.toFixed(2)}, semantic dispersion ${metrics.semantic_dispersion.toFixed(2)}.`}
      </p>
      <span aria-hidden="true">
        <span className="live-metrics-readout__value">{metrics.total_ideas}</span> ideas
      </span>
      <span aria-hidden="true">·</span>
      <span aria-hidden="true">
        <span className="live-metrics-readout__value">{metrics.unique_ideas}</span> unique
      </span>
      <span aria-hidden="true">·</span>
      <span aria-hidden="true">
        non-duplicate{" "}
        <span className="live-metrics-readout__value">
          {metrics.non_duplicate_ratio.toFixed(2)}
        </span>
      </span>
      <span aria-hidden="true">·</span>
      <span aria-hidden="true">
        dispersion{" "}
        <span className="live-metrics-readout__value">
          {metrics.semantic_dispersion.toFixed(2)}
        </span>
      </span>
      {metrics.collapse_alert && (
        <p
          role="alert"
          className="flex w-full items-start gap-1.5 font-sans text-xs font-medium text-caution-night"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Diversity collapse warning: the idea pool is converging early (non-duplicate
          ratio below 0.5). Consider a more diverse cast of personas or models next run.
        </p>
      )}
    </div>
  );
}
