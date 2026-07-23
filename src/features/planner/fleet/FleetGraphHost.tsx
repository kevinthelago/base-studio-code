// The fleet page host (#3606/#3608, epic #3604) — renders the FleetPage FROM THE GRAPH. The cockpit's fleet
// dashboard is sourced from the components graph (the authored `fleetpage` node, seeded from
// `data/components/app/**`), not a bundled file: Slice 4 deleted Fleet.tsx + its panels, so the graph is now
// the SOLE source. It registers the fleet's injected platform surface (WorkerDetail + the fleet hooks/logic
// the graph page imports), then mounts `fleetpage` through the runtime loader.
//
// On a normal (boot-seeded) install the source is always present. The fallback shows ONLY if the source is
// missing or fails to compile/load — a graceful notice, never a blank cockpit.
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { registerFleetPlatform } from "./graphPlatform";

// Register at module load — before GlanceWorkspace ever renders the fleet page — so the fleet's injected
// modules are in the registry when the graph page's compiled `require()` runs. Idempotent.
registerFleetPlatform();

/** Shown only if the `fleetpage` graph source is absent or fails to load — rare on a seeded install. */
function FleetUnavailable() {
  return (
    <EmptyState
      icon="⑃"
      title="Fleet page unavailable"
      description="The fleet dashboard loads from the components graph, and its source isn't in the library. Reopen the page, or re-seed the component library (Studio → apply)."
      style={{ padding: 48 }}
    />
  );
}

export function FleetGraphHost() {
  return <GraphComponent id="fleetpage" fallback={<FleetUnavailable />} />;
}
