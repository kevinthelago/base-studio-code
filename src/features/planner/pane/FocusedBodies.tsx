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
import { MarketBody } from "../bodies/MarketBody";
import { TransformationsBody } from "../bodies/TransformationsBody";
import { AutomationsBody } from "../bodies/FocusedAutomationsBody";
import { SkillsBody } from "../bodies/FocusedSkillsBody";
import { McpsBody } from "../bodies/McpsBody";
import { FeaturesBody } from "../bodies/FocusedFeaturesBody";
import { StreamsBody } from "../bodies/StreamsBody";
import type { FleetHandlers, McpHandlers } from "../bodies/focusedHandlers";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
// The Planner Components pane (#2314) — the body of the `test_ui` stage.
import { PlannerComponentsPane } from "@/features/designs";

// Re-export the shared body types so existing `from "./FocusedBodies"` imports keep resolving.
export type { FleetHandlers, McpHandlers, SyncState } from "../bodies/focusedHandlers";

/* =================================================================
   FocusedStageBody — maps a Stage to its body (#652 / #674)
   ================================================================= */

export function FocusedStageBody({ stage, data, projectId, onLinkRepo, onView, onFlow, onModel, onPersona, onTopology, onDirectorDrive, onToggleMcp, onBuildMcp, onAddMcp, onRemoveMcp, onDeployChange, requiredContext, onInject }: {
  stage: Stage;
  data?: ProjectPaneData;
  projectId?: string;
  /** Required-context topics for the Context body's written/missing checklist (#1061). */
  requiredContext?: string[];
  /** Inject a prompt into the live planner terminal (#1986) — the Source body's declare affordance. */
  onInject?: (text: string) => void;
  onLinkRepo?: (r: string) => void;
  /** Deploy stage (#919): persist the edited deployment config. */
  onDeployChange?: (next: DeployConfig) => void;
  onView?: (f: ContextFile) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
  onModel?: (streamId: string, model: ModelId | undefined) => void;
  onPersona?: (streamId: string, personaId: string | undefined) => void;
  onTopology?: (t: Topology) => void;
  onDirectorDrive?: (d: DirectorDrive) => void;
  onToggleMcp?: (id: string) => void;
  onBuildMcp?: (s: McpServer) => void;
  onAddMcp?: (input: string) => void;
  onRemoveMcp?: (id: string) => void;
}) {
  // Assemble the repeated handler sets once (#1640) so the cases below spread them instead of
  // re-threading each handler by name. Same handlers, same values — purely cuts prop-chain noise.
  const fleetHandlers: FleetHandlers = { onFlow, onModel, onPersona, onTopology, onDirectorDrive };
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
    case "market":
      // The market-research stage (#2430): read-focused rendering of the planner-recorded
      // assessment (gap statement · scored rubric · competitors · verdict) from `bsc plan market`.
      return <MarketBody projectId={projectId} />;
    case "transformations":
      // The transformations stage (#2509): the bottom-up confirm queue over the planner-recorded
      // modification rows from `bsc plan transformation` — tier by tier, confirm-only.
      return <TransformationsBody projectId={projectId} />;
    case "ui":
      // The UI stage's drop-in-files surface (#604/#829): stage design assets into the
      // project's `design/` dir for the planner to route. The pipeline-screen registry that
      // hosted this was orphaned by the focused-pane refactor — render it directly here.
      return <FileIntakePane projectKey={projectId ?? ""} />;
    case "features":
      return <FeaturesBody features={data?.features} />;
    case "streams":
      // The unified `streams` stage (#1914 — the collapsed structure+permissions def). The plan +
      // relationship graph always shows; the fleet (coordination + the per-stream roster + shared
      // deps, as collapsible cards) folds in below when the def carries the `fleet` substep — which
      // the kept blueprints always do.
      return <StreamsBody data={data} fleet={stage.fleet} {...fleetHandlers} />;
    case "mcps":
      return <McpsBody servers={data?.mcpServers} {...mcpHandlers} />;
    case "automations":
      return <AutomationsBody automations={data?.automations} />;
    case "skills":
      return <SkillsBody skills={data?.skills} />;
    case "test_ui":
      // The Planner Components pane (#2314): the project-scoped lens on the proven-component library —
      // a Components ⇄ Full UI toggle (inspect one component with pull-into-plan / open-in-studio
      // hand-offs, or the whole app assembled from the kit). Reads the global library from the store,
      // so it needs no stage data.
      return <PlannerComponentsPane />;
    default:
      return <EmptyState iconVariant="dashed" icon="⋯" title="The planner documents this stage." />;
  }
}
