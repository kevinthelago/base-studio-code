// The fleet page host (#3606, epic #3604) — renders the FleetPage FROM THE GRAPH. It registers the fleet's
// injected platform surface (WorkerDetail + the fleet hooks/logic the graph page imports), then mounts the
// authored `fleetpage` graph component through the runtime loader — with the code `Fleet` as the fallback, so
// a compile / unresolved-import / render failure degrades to the working page instead of blanking the cockpit.
//
// This is the seam the epic turns on: the cockpit's fleet page is now sourced from the graph, not this file.
// Slice 4 (#3608) removes the fallback and deletes Fleet.tsx once the graph page is the sole source.
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { registerFleetPlatform } from "./graphPlatform";
import { Fleet } from "./Fleet";

// Register at module load — before GlanceWorkspace ever renders the fleet page — so the fleet's injected
// modules are in the registry when the graph page's compiled `require()` runs. Idempotent.
registerFleetPlatform();

export function FleetGraphHost() {
  return <GraphComponent id="fleetpage" fallback={<Fleet />} />;
}
