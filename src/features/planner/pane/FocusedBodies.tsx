// FocusedBodies — the planner ProjectPane stage-body dispatcher (#1332; bodies split into
// ../bodies/Focused*Body per #1757). Each per-stage body now lives in its own file under
// `../bodies/`; this module is the `FocusedStageBody` switch that maps a Stage to its body and
// assembles the shared handler sets once. ProjectPane.tsx is the thin shell that renders it.
import "./projectPane.css";
import type { Flow, ContextFile, McpServer, ProjectPaneData } from "./projectPaneData";
import { type ModelId } from "@/app/console/lib/models";
import type { Stage } from "../stages/focusedPlan";
import type { DeployConfig } from "../lib/deployConfig";
import type { Topology } from "../relationship/relationshipGraph";
import type { DirectorDrive } from "../fleet/directorDrive";
// The merged Repositories & Deployment pane + source body (pre-existing files). #1914 collapsed the
// stage vocabulary: the `deployment` stage (repos+deploy) renders the merged Repositories & Deployment
// pane, the `streams` stage (structure+permissions) renders the plan graph + the folded-in fleet
// permissions, and `source` stays (it's in `complete`).
import { FileIntakePane } from "../bodies/FileIntakePane";
import { DeploymentBody } from "../bodies/ReposDeployView";
import { SourceBody } from "../bodies/FocusedSourceBody";
// Core planning-stage bodies (#1757 split out of this file).
import { DiscoveryBody } from "../bodies/DiscoveryBody";
import { AutomationsBody } from "../bodies/FocusedAutomationsBody";
import { SkillsBody } from "../bodies/FocusedSkillsBody";
import { McpsBody } from "../bodies/McpsBody";
import { FeaturesBody } from "../bodies/FocusedFeaturesBody";
import { AuthoringBody } from "../bodies/FocusedAuthoringBody";
import { StreamsBody } from "../bodies/StreamsBody";
import type { FleetHandlers, McpHandlers } from "../bodies/focusedHandlers";

// Re-export the shared body types so existing `from "./FocusedBodies"` imports keep resolving
// (ProjectPane imports `AuthoringWiring`).
export type { FleetHandlers, McpHandlers, AuthoringWiring, SyncState } from "../bodies/focusedHandlers";

/* =================================================================
   FocusedStageBody — maps a Stage to its body (#652 / #674)
   ================================================================= */

export function FocusedStageBody({ stage, data, projectId, authoring, onLinkRepo, onView, onFlow, onModel, onTopology, onDirectorDrive, onToggleMcp, onBuildMcp, onAddMcp, onRemoveMcp, onDeployChange, requiredContext, onInject }: {
  stage: Stage;
  data?: ProjectPaneData;
  projectId?: string;
  /** Required-context topics for the Context body's written/missing checklist (#1061). */
  requiredContext?: string[];
  /** Inject a prompt into the live planner terminal (#1986) — the Source body's declare affordance. */
  onInject?: (text: string) => void;
  /** Authoring-lifecycle wiring (#923) — present only for a blueprint-authoring project. */
  authoring?: import("../bodies/focusedHandlers").AuthoringWiring;
  onLinkRepo?: (r: string) => void;
  /** Deploy stage (#919): persist the edited deployment config. */
  onDeployChange?: (next: DeployConfig) => void;
  onView?: (f: ContextFile) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
  onModel?: (streamId: string, model: ModelId | undefined) => void;
  onTopology?: (t: Topology) => void;
  onDirectorDrive?: (d: DirectorDrive) => void;
  onToggleMcp?: (id: string) => void;
  onBuildMcp?: (s: McpServer) => void;
  onAddMcp?: (input: string) => void;
  onRemoveMcp?: (id: string) => void;
}) {
  // Assemble the repeated handler sets once (#1640) so the cases below spread them instead of
  // re-threading each handler by name. Same handlers, same values — purely cuts prop-chain noise.
  const fleetHandlers: FleetHandlers = { onFlow, onModel, onTopology, onDirectorDrive };
  const mcpHandlers: McpHandlers = { onToggle: onToggleMcp, onBuild: onBuildMcp, onAdd: onAddMcp, onRemove: onRemoveMcp };
  switch (stage.key) {
    case "source":
      return <SourceBody projectId={projectId} onInject={onInject} />;
    case "deployment":
      // The unified `deployment` stage (#1914 — the collapsed repos+deploy def) renders as one
      // cohesive Repositories & Deployment pane: each repo's git identity merged with its deploy
      // target (click a repo to expand its target editor inline).
      return (
        <DeploymentBody
          repos={data?.repos} deploy={data?.deploy} onDeployChange={onDeployChange}
          onLinkRepo={onLinkRepo}
        />
      );
    case "discovery":
      return <DiscoveryBody context={data?.context} onView={onView} requiredContext={requiredContext} />;
    case "ui":
      // The UI stage's drop-in-files surface (#604/#829): stage design assets into the
      // project's `design/` dir for the planner to route. The pipeline-screen registry that
      // hosted this was orphaned by the focused-pane refactor — render it directly here.
      return <FileIntakePane projectKey={projectId ?? ""} />;
    case "features":
      return <FeaturesBody features={data?.features} />;
    case "streams":
      // The unified `streams` stage (#1914 — the collapsed structure+permissions def). The plan +
      // relationship graph always shows; the fleet (coordination + per-stream permissions, via the
      // embedded PermissionsBody) folds in below when the def carries the `fleet` substep — which the
      // kept blueprints always do.
      return <StreamsBody data={data} fleet={stage.fleet} {...fleetHandlers} />;
    case "mcps":
      return <McpsBody servers={data?.mcpServers} {...mcpHandlers} />;
    case "automations":
      return <AutomationsBody automations={data?.automations} />;
    case "skills":
      return <SkillsBody skills={data?.skills} />;
    // Blueprint-authoring stages (#923): the interactive editor views over the in-progress blueprint.
    case "purpose":
    case "bp_stages":
    case "bp_capabilities":
    case "bp_review":
      return <AuthoringBody bp={data?.authoredBlueprint} stageKey={stage.key} wiring={authoring} />;
    default:
      return (
        <div className="empty-state">
          <span className="empty-icon">⋯</span>
          <span>The planner documents this stage.</span>
        </div>
      );
  }
}
