// The fleet page host (#3606/#3608, epic #3604) — renders the FleetPage FROM THE GRAPH. The cockpit's fleet
// dashboard is sourced from the components graph (the authored `fleetpage` node, seeded from
// `data/components/app/**`), not a bundled file: Slice 4 deleted Fleet.tsx + its panels, so the graph is now
// the SOLE source. It registers the fleet's injected platform surface (WorkerDetail + the fleet hooks/logic
// the graph page imports), then mounts `fleetpage` through the runtime loader.
//
// On a normal (boot-seeded) install the source is always present. The fallback shows ONLY if the source is
// missing or fails to compile/load — a graceful notice, never a blank cockpit.
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { GraphPageFallback } from "@/shared/lib/runtime/GraphPageFallback";
import { registerFleetPlatform } from "./graphPlatform";

// Register at module load — before GlanceWorkspace ever renders the fleet page — so the fleet's injected
// modules are in the registry when the graph page's compiled `require()` runs. Idempotent.
registerFleetPlatform();

export function FleetGraphHost() {
  // Shown only if the `fleetpage` graph source is absent or fails to load — rare on a seeded install; the
  // fallback offers a one-click re-seed (#3648) so recovery never needs a Settings/Studio trip.
  return <GraphComponent id="fleetpage" fallback={<GraphPageFallback page="Fleet" icon="⑃" />} />;
}
