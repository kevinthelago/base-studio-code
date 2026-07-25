// The Automations page host (#3642, epic #3604) — renders the Automations workspace FROM THE GRAPH. The
// page + its 3 tab bodies (Schedules, History, Hook Analytics) are sourced from the components graph (the
// authored `automationspage` node + siblings, seeded from `data/components/app/**`), not bundled files. It
// registers the automations feature's injected platform surface (mcp + the scheduler/cron/format logic the
// graph page imports), then mounts `automationspage` through the runtime loader. Mirrors `FleetGraphHost`.
//
// `pageOverride` (a torn-off single tab, DetachedWindow) forwards to the graph component as a prop —
// GraphComponent spreads props onto the loaded component, and the graph `AutomationsWorkspace` reads it.
//
// The CSS still ships as a normal bundled import here (the loader can't resolve a CSS side-effect import,
// so it was stripped from the graph source): the host owns the stylesheet the graph page's classes need.
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { GraphPageFallback } from "@/shared/lib/runtime/GraphPageFallback";
import { registerAutomationsPlatform } from "./graphPlatform";
import "./automations.css";

// Register at module load — before the workspace ever renders — so the injected modules are in the registry
// when the graph page's compiled `require()` runs. Idempotent.
registerAutomationsPlatform();

export function AutomationsGraphHost({ pageOverride }: { pageOverride?: string } = {}) {
  // Fallback offers a one-click re-seed (#3648) when the source isn't in the library yet.
  return (
    <GraphComponent
      id="automationspage"
      props={pageOverride ? { pageOverride } : undefined}
      fallback={<GraphPageFallback page="Automations" icon="⏱" />}
    />
  );
}
