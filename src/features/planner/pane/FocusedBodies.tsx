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
import { StreamsBody } from "../bodies/StreamsBody";
import type { FleetHandlers, McpHandlers } from "../bodies/focusedHandlers";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
// The project planner's LIBRARY surface (#4265) — the components lens (#2314) and the algorithms lens
// together. Folded into the `features` stage, which every packaged blueprint carries; `test_ui` (which
// none do, since #4249) keeps rendering it so a user blueprint carrying that stage still resolves.
import { PlannerLibraryPane } from "../bodies/PlannerLibraryPane";
import { FeaturesStageBody } from "../bodies/FeaturesStageBody";
import { PreviewPaneShell } from "../preview/PreviewPaneShell";
import { useAppStore } from "@/store";

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
  // #3783: the UI stage renders one of two surfaces per the project's UI mode (planner-set at
  // discovery; an unset project defaults to "custom" — the in-app designer preview).
  const uiMode = useAppStore((s) => (projectId ? s.planClassification[projectId]?.uiMode : undefined) ?? "custom");
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
      // #3783: the UI stage renders one of two surfaces depending on the project's UI mode.
      // "custom" (default) = the in-app designer preview — the render-preview pipeline shows the
      // navigable shell the designer commissions (PreviewPaneShell). "external" = the drop-in-files
      // surface (#604/#829) that stages Claude-Design assets into `design/` for the planner to route.
      return uiMode === "external"
        ? <FileIntakePane projectKey={projectId ?? ""} />
        : <PreviewPaneShell projectKey={projectId ?? ""} />;
    case "features":
      // #4265: the plan AND the library it should be built from — the stage where reuse-vs-commission
      // is decided is the stage that shows what there is to reuse.
      return <FeaturesStageBody features={data?.features} projectId={projectId} />;
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
      // Legacy home of the components lens. #4249 retired this stage (no packaged blueprint carries
      // it), so the library now lives on `features` — but a USER blueprint may still carry `test_ui`,
      // and it gets the same both-libraries dock rather than a dead pane.
      return <PlannerLibraryPane />;
    default:
      return <EmptyState iconVariant="dashed" icon="⋯" title="The planner documents this stage." />;
  }
}
