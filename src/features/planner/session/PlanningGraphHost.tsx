// The Planning session host (#4224, epic #3604) — renders the planner's flagship page FROM THE GRAPH.
//
// `visible` is load-bearing and is why this host takes props at all. The planner Screen keeps Planning
// MOUNTED while showing another tab (the session's terminal must not be torn down when you glance at the
// board), and passes `visible` so the page can pause its own work. Forwarding it through
// `GraphComponent`'s `props` is the same mechanism the other hosts use for `pageOverride` — and #4200 is
// the reminder that a page mounted with props needs its host to actually pass them.
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { GraphPageFallback } from "@/shared/lib/runtime/GraphPageFallback";
import { registerPlanningPlatform } from "./graphPlatform";
// #4227: the pane is `provides`-resolved from the graph, and the vendored pane reaches ~21 modules the
// session itself never imports (the stage bodies, the preview chain). Registering them is the pane's own
// job, but CALLING it is the host's — the loader asks for them while compiling this page.
import { registerPanePlatform } from "../pane/graphPlatform";
// #4230: and the pane's stage bodies are `provides`-resolved in turn, reaching another 36 modules of
// their own. Three registration calls, one per directory that became graph source — each owned by the
// directory it registers for, all called from the one host that mounts the page they compose.
import { registerBodiesPlatform } from "../bodies/graphPlatform";

registerPlanningPlatform();
registerPanePlatform();
registerBodiesPlatform();

export function PlanningGraphHost({ visible }: { visible?: boolean } = {}) {
  return (
    <GraphComponent
      id="planningpage"
      props={visible === undefined ? undefined : { visible }}
      fallback={<GraphPageFallback page="Planning" icon="◈" />}
    />
  );
}
