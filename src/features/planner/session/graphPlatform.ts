// The planning session's graph-platform surface (#4224, epic #3604) — originally generated from what
// the `planningpage` records import, now HAND-MAINTAINED: `scripts/gen-planning-graph.cjs` was retired
// with the rest of the one-off generators, because it read source files the migration deletes and would
// break the moment one went. Edit this by hand and keep it in step with the records' imports; git
// history holds the generator if the derivation ever needs re-reading.
//
// These are the modules that RUN the session — the terminal, the tag stream, the gates, the publish
// pipeline, the autopilot, the conductor. The graph carries the arrangement; every one of these stays
// code, registered here so the loaded page's `require()` reaches the live module.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as BlueprintSkills from "@/features/planner/blueprints/blueprintSkills";
import * as AgentFlow from "@/features/planner/fleet/agentFlow";
import * as PlanFleet from "@/features/planner/fleet/planFleet";
import * as WorkerScope from "@/features/planner/fleet/workerScope";
import * as GhStructure from "@/features/planner/github/ghStructure";
import * as Dependencies from "@/features/planner/issues/dependencies";
import * as FeatureList from "@/features/planner/issues/featureList";
import * as PlanFeatures from "@/features/planner/issues/planFeatures";
import * as PlanIssues from "@/features/planner/issues/planIssues";
import * as ClassifyConfig from "@/features/planner/lib/classifyConfig";
import * as DeployConfig from "@/features/planner/lib/deployConfig";
import * as FileIntake from "@/features/planner/lib/fileIntake";
import * as McpPaneData from "@/features/planner/lib/mcpPaneData";
import * as PlanInjection from "@/features/planner/lib/planInjection";
import * as ProjectRepos from "@/features/planner/list/projectRepos";
import * as McpDownloadModal from "@/features/planner/pane/McpDownloadModal";
import * as ProjectPaneData from "@/features/planner/pane/projectPaneData";
import * as PlanAutopilotRunner from "@/features/planner/session/planAutopilotRunner";
import * as PlannerConductor from "@/features/planner/session/plannerConductor";
import * as ProjectTitle from "@/features/planner/session/projectTitle";
import * as UseDesignRouteState from "@/features/planner/session/useDesignRouteState";
import * as UsePlanConfirmations from "@/features/planner/session/usePlanConfirmations";
import * as UsePlanFocusedPane from "@/features/planner/session/usePlanFocusedPane";
import * as UsePlanStagePoll from "@/features/planner/session/usePlanStagePoll";
import * as UsePlannerPromptDelivery from "@/features/planner/session/usePlannerPromptDelivery";
import * as UsePlannerTunnelSync from "@/features/planner/session/usePlannerTunnelSync";
import * as UsePlanningModals from "@/features/planner/session/usePlanningModals";
import * as UsePlanningSession from "@/features/planner/session/usePlanningSession";
import * as Blueprints from "@/features/planner/stages/blueprints";
import * as ConfirmReconcile from "@/features/planner/stages/confirmReconcile";
import * as FocusedPlan from "@/features/planner/stages/focusedPlan";
import * as PlanStages from "@/features/planner/stages/planStages";
import * as PlanTopics from "@/features/planner/stages/planTopics";
// ── Reached only THROUGH a migrated logic module (retire-the-first-19-logic-modules) ─────────────
// A module that becomes an algorithm record stops being resolved by Vite and starts being resolved by
// the LOADER, so its own imports become the graph's problem. None of these were registered before,
// because no record imported them DIRECTLY — each arrives transitively with the hook that was retired.
import * as GitHubStructureCard from "@/features/planner/session/GitHubStructureCard";
import * as PublishSteps from "@/features/planner/session/publishSteps";
import * as PlannerIntro from "@/features/planner/session/plannerIntro";
import * as PlanningTerminal from "@/features/planner/session/planningTerminal";
import * as PlannerLaunch from "@/features/planner/session/plannerLaunch";
import * as PlannerSandbox from "@/features/planner/session/plannerSandbox";
import * as RenameProject from "@/features/planner/session/renameProject";
import * as DraftTitle from "@/features/planner/session/draftTitle";

let done = false;

/** Register the Planning session's injected graph-platform modules. Idempotent. */
export function registerPlanningPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/planner/blueprints/blueprintSkills", BlueprintSkills);
  registerAppModule("@/features/planner/fleet/agentFlow", AgentFlow);
  registerAppModule("@/features/planner/fleet/planFleet", PlanFleet);
  registerAppModule("@/features/planner/fleet/workerScope", WorkerScope);
  registerAppModule("@/features/planner/github/ghStructure", GhStructure);
  registerAppModule("@/features/planner/issues/dependencies", Dependencies);
  registerAppModule("@/features/planner/issues/featureList", FeatureList);
  registerAppModule("@/features/planner/issues/planFeatures", PlanFeatures);
  registerAppModule("@/features/planner/issues/planIssues", PlanIssues);
  registerAppModule("@/features/planner/lib/classifyConfig", ClassifyConfig);
  registerAppModule("@/features/planner/lib/deployConfig", DeployConfig);
  registerAppModule("@/features/planner/lib/fileIntake", FileIntake);
  registerAppModule("@/features/planner/lib/mcpPaneData", McpPaneData);
  registerAppModule("@/features/planner/lib/planInjection", PlanInjection);
  registerAppModule("@/features/planner/list/projectRepos", ProjectRepos);
  registerAppModule("@/features/planner/pane/McpDownloadModal", McpDownloadModal);
  registerAppModule("@/features/planner/pane/projectPaneData", ProjectPaneData);
  registerAppModule("@/features/planner/session/planAutopilotRunner", PlanAutopilotRunner);
  registerAppModule("@/features/planner/session/plannerConductor", PlannerConductor);
  registerAppModule("@/features/planner/session/projectTitle", ProjectTitle);
  registerAppModule("@/features/planner/session/useDesignRouteState", UseDesignRouteState);
  registerAppModule("@/features/planner/session/usePlanConfirmations", UsePlanConfirmations);
  registerAppModule("@/features/planner/session/usePlanFocusedPane", UsePlanFocusedPane);
  registerAppModule("@/features/planner/session/usePlanStagePoll", UsePlanStagePoll);
  registerAppModule("@/features/planner/session/usePlannerPromptDelivery", UsePlannerPromptDelivery);
  registerAppModule("@/features/planner/session/usePlannerTunnelSync", UsePlannerTunnelSync);
  registerAppModule("@/features/planner/session/usePlanningModals", UsePlanningModals);
  registerAppModule("@/features/planner/session/usePlanningSession", UsePlanningSession);
  registerAppModule("@/features/planner/stages/blueprints", Blueprints);
  registerAppModule("@/features/planner/stages/confirmReconcile", ConfirmReconcile);
  registerAppModule("@/features/planner/stages/focusedPlan", FocusedPlan);
  registerAppModule("@/features/planner/stages/planStages", PlanStages);
  registerAppModule("@/features/planner/stages/planTopics", PlanTopics);
  registerAppModule("@/features/planner/session/GitHubStructureCard", GitHubStructureCard);
  registerAppModule("@/features/planner/session/publishSteps", PublishSteps);
  registerAppModule("@/features/planner/session/plannerIntro", PlannerIntro);
  registerAppModule("@/features/planner/session/planningTerminal", PlanningTerminal);
  registerAppModule("@/features/planner/session/plannerLaunch", PlannerLaunch);
  registerAppModule("@/features/planner/session/plannerSandbox", PlannerSandbox);
  registerAppModule("@/features/planner/session/renameProject", RenameProject);
  registerAppModule("@/features/planner/session/draftTitle", DraftTitle);
}
