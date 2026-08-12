// The planner feature's graph-platform surface (register-the-feature-logic-surface) — the modules a
// graph-loaded record imports from this feature but does NOT redraw.
//
// Registered HERE, inside the feature, because the shell must not reach a feature's internals (#1545)
// and eager-importing them from `app/` would de-lazy the whole feature at boot. The feature's BARREL
// calls this at module load, so the shadow catalogue's `ensurePlatform: () => import("@/features/planner")`
// is what registers them — the same shape `registerAutomationsPlatform` already uses.
//
// These files STAY on disk: registration is not migration. It makes a record that imports them
// loadable, which is the prerequisite for migrating the modules that import THEM.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import { registerProjectsPlatform } from "./list/graphPlatform";
import * as GraphPlatform from "@/features/planner/list/graphPlatform";
import * as PullIntoPlan from "@/features/planner/lib/pullIntoPlan";
import * as GraphPlatform2 from "@/features/planner/fleet/graphPlatform";
import * as ProjectBoardTypes from "@/features/planner/github/projectBoard.types";
import * as IssuesModel from "@/features/planner/github/issues/issuesModel";
import * as ProjectScan from "@/features/planner/list/projectScan";
import * as ProjectBoardQuery from "@/features/planner/github/projectBoard.query";
import * as RoadmapGantt from "@/features/planner/github/roadmapGantt";
import * as GraphPlatform3 from "@/features/planner/session/graphPlatform";
import * as GraphPlatform4 from "@/features/planner/github/graphPlatform";
import * as UseProjectScan from "@/features/planner/list/useProjectScan";
import * as ProjectModes from "@/features/planner/list/projectModes";
import * as PlannerCore from "@/features/planner/lib/plannerCore";
import * as PlanBoardProjection from "@/features/planner/session/planBoardProjection";
import * as Manifest from "@/features/planner/lib/gist/manifest";
import * as FlowPermissions from "@/features/planner/fleet/flowPermissions";
import * as ProjectsSummaryDerive from "@/features/planner/list/projectsSummaryDerive";
import * as UseProjectsSummaryData from "@/features/planner/list/summary/useProjectsSummaryData";
import * as Types from "@/features/planner/preview/types";
import * as GraphPlatform5 from "@/features/planner/pane/graphPlatform";
import * as GraphPlatform6 from "@/features/planner/bodies/graphPlatform";
import * as GraphPlatform7 from "@/features/planner/preview/graphPlatform";
// ── Reached only THROUGH a migrated logic module (retire-the-first-19-logic-modules) ─────────────
// A module that becomes an algorithm record stops being resolved by Vite and starts being resolved by
// the LOADER, so its own imports become the graph's problem. None of these were registered before,
// because no record imported them DIRECTLY — each arrives transitively with the hook that was retired.
import * as PlanStageDerive from "@/features/planner/stages/planStageDerive";
import * as LintPlan from "@/features/planner/lib/lintPlan";
import * as BlueprintMcp from "@/features/planner/blueprints/blueprintMcp";
import * as McpContext from "@/features/planner/lib/mcpContext";
import * as PlanExtensions from "@/features/planner/lib/planExtensions";
import * as RecoverIssues from "@/features/planner/issues/recoverIssues";

let done = false;

/** Register this feature's injected graph-platform modules by the specifiers a record imports. Idempotent. */
export function registerPlannerPlatform(): void {
  if (done) return;
  done = true;
  // The LIST platform, registered from here because `planningpage`'s `ensurePlatform` loads this feature's
  // barrel and the barrel only ever CALLED this one — `registerProjectsPlatform` was merely re-exported.
  // That gap was invisible while the planner's hooks were files: `usePlanGates` imported
  // `../list/projectsDbBridge` and Vite resolved it at module load, never touching the registry. As
  // records those imports go through the LOADER, which resolves only what has actually been registered —
  // so the page failed to load on a module that was registered in a function nothing called.
  registerProjectsPlatform();
  registerAppModule("@/features/planner/list/graphPlatform", GraphPlatform);
  registerAppModule("@/features/planner/lib/pullIntoPlan", PullIntoPlan);
  registerAppModule("@/features/planner/fleet/graphPlatform", GraphPlatform2);
  registerAppModule("@/features/planner/github/projectBoard.types", ProjectBoardTypes);
  registerAppModule("@/features/planner/github/issues/issuesModel", IssuesModel);
  registerAppModule("@/features/planner/list/projectScan", ProjectScan);
  registerAppModule("@/features/planner/github/projectBoard.query", ProjectBoardQuery);
  registerAppModule("@/features/planner/github/roadmapGantt", RoadmapGantt);
  registerAppModule("@/features/planner/session/graphPlatform", GraphPlatform3);
  registerAppModule("@/features/planner/github/graphPlatform", GraphPlatform4);
  registerAppModule("@/features/planner/list/useProjectScan", UseProjectScan);
  registerAppModule("@/features/planner/list/projectModes", ProjectModes);
  registerAppModule("@/features/planner/lib/plannerCore", PlannerCore);
  registerAppModule("@/features/planner/session/planBoardProjection", PlanBoardProjection);
  registerAppModule("@/features/planner/lib/gist/manifest", Manifest);
  registerAppModule("@/features/planner/fleet/flowPermissions", FlowPermissions);
  registerAppModule("@/features/planner/list/projectsSummaryDerive", ProjectsSummaryDerive);
  registerAppModule("@/features/planner/list/summary/useProjectsSummaryData", UseProjectsSummaryData);
  registerAppModule("@/features/planner/preview/types", Types);
  registerAppModule("@/features/planner/pane/graphPlatform", GraphPlatform5);
  registerAppModule("@/features/planner/bodies/graphPlatform", GraphPlatform6);
  registerAppModule("@/features/planner/preview/graphPlatform", GraphPlatform7);
  registerAppModule("@/features/planner/stages/planStageDerive", PlanStageDerive);
  registerAppModule("@/features/planner/lib/lintPlan", LintPlan);
  registerAppModule("@/features/planner/blueprints/blueprintMcp", BlueprintMcp);
  registerAppModule("@/features/planner/lib/mcpContext", McpContext);
  registerAppModule("@/features/planner/lib/planExtensions", PlanExtensions);
  registerAppModule("@/features/planner/issues/recoverIssues", RecoverIssues);
}
