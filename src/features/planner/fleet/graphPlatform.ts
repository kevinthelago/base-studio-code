// The fleet feature's graph-platform surface (#3606, epic #3604) — the fleet-INTERNAL modules a graph-loaded
// FleetPage imports but does NOT redraw: the `WorkerDetail` drill-in (a behavioural leaf kept as code per the
// dashboard-only scope) and the `useFleetGithub` / `fleetCost` logic (injected for #3606). The PURE dashboard
// computations were harvested into the algorithms graph and these libs now DELEGATE to those nodes (#3607:
// fleetCost→llmEnergy+groupTotals, fleetHealth→streamMerge, fleetGithub→windowedTally+orderByRank,
// fleetLive→precedenceResolve); what's injected here is the thin typed store-glue the loader wires the real
// store into — a React hook can't be a no-import graph node, so this injection IS "the loader injects the store".
// Registered HERE, inside the feature, because the shell must not reach a
// feature's internals (#1545) and eager-importing them from `app/` would de-lazy the whole planner at boot.
// The fleet host calls this synchronously before the graph page loads, so the modules are present when the
// compiled page's `require()` runs.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as Skills from "@/features/skills"; // FleetLessons reads loadPendingLessons/lessonTitle from the skills barrel
import * as UseFleetGithub from "./useFleetGithub";
import * as FleetCost from "./lib/fleetCost";
import * as FleetHealthLib from "./lib/fleetHealth";
import * as WorkerDetail from "./WorkerDetail";
// #4238 — `WorkerDetail` is now a `provides` RECORD, so the loader vendors its source rather than
// handing back this module (which stays as the fallback). Vendoring makes the loader responsible for
// what the detail panel reaches, and these five are what it reaches.
import * as FleetWorker from "./fleetWorker";
import * as WorkerDetailHelpers from "./workerDetail.helpers";
import * as WorkerDetailPlaceholder from "./WorkerDetailPlaceholder";
import * as WorkerModals from "./WorkerModals";
import * as Security from "@/features/security";

let done = false;

/** Register the fleet's injected graph-platform modules by the specifiers its graph page imports. Idempotent. */
export function registerFleetPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/skills", Skills);
  registerAppModule("@/features/planner/fleet/useFleetGithub", UseFleetGithub);
  registerAppModule("@/features/planner/fleet/lib/fleetCost", FleetCost);
  registerAppModule("@/features/planner/fleet/lib/fleetHealth", FleetHealthLib);
  registerAppModule("@/features/planner/fleet/WorkerDetail", WorkerDetail);
  registerAppModule("@/features/planner/fleet/fleetWorker", FleetWorker);
  registerAppModule("@/features/planner/fleet/workerDetail.helpers", WorkerDetailHelpers);
  registerAppModule("@/features/planner/fleet/WorkerDetailPlaceholder", WorkerDetailPlaceholder);
  registerAppModule("@/features/planner/fleet/WorkerModals", WorkerModals);
  registerAppModule("@/features/security", Security);
}
