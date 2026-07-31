// #4071 fixture — the HONEST failure the harvester must keep reporting.
//
// `@/features/nowhere/lib/missing` is not a harvested sibling and is NOT in the runtime module registry
// (`platform-modules.json`), so nothing resolves it: no kit component, no sibling `src`, no registered
// platform module. It must stay `buildable: false` with the specifier named.
//
// Panel.tsx is the counterpart — its imports are a sibling and a REGISTERED platform module, both of
// which resolve, so it is buildable.
import { readGauge } from "@/features/nowhere/lib/missing";

export function Gauge({ label }: { label: string }) {
  const value = readGauge(label);
  return (
    <div className="gauge">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
