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

registerPlanningPlatform();

export function PlanningGraphHost({ visible }: { visible?: boolean } = {}) {
  return (
    <GraphComponent
      id="planningpage"
      props={visible === undefined ? undefined : { visible }}
      fallback={<GraphPageFallback page="Planning" icon="◈" />}
    />
  );
}
