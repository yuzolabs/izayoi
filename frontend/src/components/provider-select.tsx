import { Select } from "@/components/ui/select";
import type { ProviderInfo } from "@/lib/api";

/**
 * Provider + model pair. Unavailable providers stay visible but disabled,
 * annotated with the missing environment variable (per product spec).
 */
export function ProviderModelSelect({
  providers,
  provider,
  model,
  onChange,
  compact = false,
}: {
  providers: ProviderInfo[];
  provider: string;
  model: string;
  onChange: (provider: string, model: string) => void;
  compact?: boolean;
}) {
  const current = providers.find((p) => p.id === provider);
  const models = current?.models ?? [];
  return (
    <div className={compact ? "grid grid-cols-2 gap-1.5" : "grid grid-cols-2 gap-2"}>
      <Select
        aria-label="Provider"
        value={provider}
        onChange={(e) => {
          const next = providers.find((p) => p.id === e.target.value);
          if (next) onChange(next.id, next.models[0] ?? "");
        }}
      >
        {!current && <option value={provider}>{provider || "Select provider"}</option>}
        {providers.map((p) => (
          <option key={p.id} value={p.id} disabled={!p.available}>
            {p.label}
            {p.available ? "" : ` — env var ${p.env_var} not set`}
          </option>
        ))}
      </Select>
      <Select aria-label="Model" value={model} onChange={(e) => onChange(provider, e.target.value)}>
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        {!models.includes(model) && model && <option value={model}>{model}</option>}
      </Select>
    </div>
  );
}

/** Providers usable right now (available flag on). */
export function availableProviders(providers: ProviderInfo[]): ProviderInfo[] {
  return providers.filter((p) => p.available);
}
