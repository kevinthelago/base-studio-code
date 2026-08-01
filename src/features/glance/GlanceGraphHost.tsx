// The Glance page host (#4185, epic #3604) — renders the cockpit FROM THE GRAPH. The workspace and the 8
// components it composes are sourced from the components graph (the authored `glancepage` node + siblings,
// seeded from `data/components/app/**`), not bundled files. It registers the glance feature's injected
// platform surface (the ~17 hooks and pure derivations the cockpit is thin over, plus the other features'
// surfaces it composes), then mounts `glancepage` through the runtime loader.
//
// The CSS still ships as a normal bundled import here: the loader cannot resolve a CSS side-effect import,
// so it was stripped from the graph source and the host owns the stylesheet the page's classes need.
//
// A GRAPH PAGE INSIDE A GRAPH PAGE. Glance mounts `FleetGraphHost`, which mounts `fleetpage` — so a
// graph-loaded page now hosts another. That is not a new mechanism (the loader already vendors siblings
// recursively) but it is the first time one arrives through a HOST rather than an import, and each keeps
// its own error boundary: a broken fleetpage degrades inside a working Glance.
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { GraphPageFallback } from "@/shared/lib/runtime/GraphPageFallback";
import { registerGlancePlatform } from "./graphPlatform";
import "./glance.css";

// Register at module load — before the workspace ever renders — so the injected modules are in the registry
// when the graph page's compiled `require()` runs. Idempotent.
registerGlancePlatform();

export function GlanceGraphHost() {
  // Fallback offers Reload-to-apply / Re-seed (#3648/#3652) when the source isn't in the library yet.
  return <GraphComponent id="glancepage" fallback={<GraphPageFallback page="Glance" icon="◎" />} />;
}
