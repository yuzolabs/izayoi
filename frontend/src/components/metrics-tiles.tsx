import { AlertTriangle, Gauge, Layers, PieChart, Waves } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import type { SessionMetrics } from "@/lib/api";

export function MetricsTiles({ metrics }: { metrics: SessionMetrics }) {
  const tiles = [
    { icon: Layers, label: "Ideas", value: String(metrics.total_ideas) },
    { icon: PieChart, label: "Unique", value: String(metrics.unique_ideas) },
    {
      icon: Gauge,
      label: "Non-duplicate ratio",
      value: metrics.non_duplicate_ratio.toFixed(2),
    },
    {
      icon: Waves,
      label: "Semantic dispersion",
      value: metrics.semantic_dispersion.toFixed(2),
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((tile) => (
        <Card key={tile.label}>
          <CardContent className="flex items-center gap-3 p-4">
            <tile.icon className="h-5 w-5 shrink-0 text-primary" />
            <div className="min-w-0">
              <div className="font-mono text-xl font-semibold leading-none">{tile.value}</div>
              <div className="mt-1 truncate text-xs text-muted-foreground">{tile.label}</div>
            </div>
          </CardContent>
        </Card>
      ))}
      {metrics.collapse_alert && (
        <Card className="col-span-2 border-caution/50 bg-caution/10 sm:col-span-4">
          <CardContent className="flex items-center gap-2 p-3 text-sm">
            <AlertTriangle className="h-4 w-4 text-caution" />
            <span>
              <strong>Diversity collapse warning:</strong> the idea pool shows low diversity
              (NDR below 0.5 or minimal semantic dispersion). Consider rerunning with more
              diverse personas or different model families.
            </span>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
