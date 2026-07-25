// Plan-session domain — Claude config profiles, plan section files, blueprints, data models,
// stage config/runs/preview, and the agent fleet plan. Plus the config + automation-suggestion
// value types it owns. Split from store/types (#1634).
import type { ModelId } from "@/app/console/panes/PaneMenu";
import type { AgentFlow } from "@/features/planner/fleet/agentFlow";
import type { FleetPlan, AgentStream } from "@/features/planner/fleet/planFleet";
import type { Topology } from "@/features/planner/relationship/relationshipGraph";
import type { StageConfig, StageId } from "@/features/planner/stages/planStages";
import type { StageRunState } from "@/features/planner/preview/stageRun";
import type { Blueprint, BlueprintStage } from "@/features/planner/stages/blueprints";
import type { DeployConfig } from "@/features/planner/lib/deployConfig";
import type { MarketConfig } from "@/features/planner/lib/marketConfig";
import type { TransformationRow } from "@/features/planner/lib/transformations";
import type { SourceConfig } from "@/features/planner/lib/sourceConfig";
import type { IntegrationStrategy } from "@/features/planner/lib/integrationStrategy";
import type { DirectorDrive } from "@/features/planner/fleet/directorDrive";

export interface ToolPermissions {
  allow: string[];
  deny: string[];
}

export interface ConfigProfile {
  id: string;
  name: string;
  instructions: string;
  tools: ToolPermissions;
}

export interface AutomationSuggestion {
  name: string;
  command: string;
  schedule?: string;
  description?: string;
}

/** Plan-session slice of {@link AppStore}. */
export interface PlanState {
  // Claude config profiles (persisted)
  configProfiles: ConfigProfile[];
  addConfigProfile: (profile: Omit<ConfigProfile, "id">) => void;
  updateConfigProfile: (id: string, patch: Partial<Omit<ConfigProfile, "id">>) => void;
  removeConfigProfile: (id: string) => void;

  // Plan session data — persisted per project so navigation away doesn't lose state.
  planStages:    Record<string, Record<string, string>>;
  setPlanStage:  (projectId: string, key: string, content: string) => void;
  planConfirmedStages: Record<string, string[]>;
  confirmPlanStage:   (projectId: string, key: string) => void;
  unconfirmPlanStage: (projectId: string, key: string) => void;
  /** Add a confirmation to the store ONLY (no plan.db write-through) — the poll uses this to
   *  rehydrate the durable confirmed set (#2256) from plan.db on revisit without echoing it back. */
  markStageConfirmedLocal: (projectId: string, key: string) => void;
  /** Per-project deployment & infrastructure config (#919) — edited by the planner's Deploy
   *  stage pane; the `deploymentDefined` gate signal derives from it. */
  planDeployConfig: Record<string, DeployConfig>;
  setPlanDeployConfig: (projectId: string, cfg: DeployConfig) => void;
  /** Per-project market assessment (#2430) — the scored desk-research rubric the planner records
   *  via `bsc plan market set` (reflected from plan.db by the stage poll); the `marketDefined`
   *  gate signal derives from it. */
  planMarketConfig: Record<string, MarketConfig>;
  setPlanMarketConfig: (projectId: string, cfg: MarketConfig) => void;
  /** Per-project transformations list (#2509) — the verb-shaped modification rows the planner
   *  records via `bsc plan transformation add` (reflected from plan.db by the stage poll); the
   *  `transformationsConfirmed` gate signal derives from it. */
  planTransformations: Record<string, TransformationRow[]>;
  setPlanTransformations: (projectId: string, rows: TransformationRow[]) => void;
  /** Per-project migration SOURCE config (#source-pane) — the legacy systems a project migrates
   *  from, declared + connected read-only in the Source stage pane; the `sourcesConnected` gate
   *  signal derives from it. Secret credentials are NEVER stored here (they live in the OS keychain). */
  planSourceConfig: Record<string, SourceConfig>;
  setPlanSourceConfig: (projectId: string, cfg: SourceConfig) => void;
  /** Per-project DEFAULT GitHub repo visibility for new repos at publish (#…). Absent ⇒ false ⇒
   *  PRIVATE; a per-repo override (`repoPublic`) wins over it. Set the default for the project (and
   *  the fallback for repos with no override). */
  reposPublic: Record<string, boolean>;
  setReposPublic: (projectId: string, isPublic: boolean) => void;
  /** Per-REPO GitHub visibility override (#1227), keyed `<projectKey>::<repoFullName>`. Wins over
   *  the project default `reposPublic`; absent ⇒ falls back to the default ⇒ private. Resolved by
   *  `resolveRepoPublic` at the Repos card + at publish. */
  repoPublic: Record<string, boolean>;
  setRepoPublic: (projectKey: string, repoId: string, isPublic: boolean) => void;
  /** #1107: per-project signature of the injection findings the user acknowledged (acknowledge-to-
   *  clear). Cleared when findings change; ignored when the hard-gate setting is on. */
  planInjectionAck: Record<string, string>;
  acknowledgePlanInjections: (projectId: string, signature: string) => void;
  /** Optional stages the user deliberately SKIPPED (#921). The flow stops on every optional stage;
   *  skipping marks it resolved (frontier advances, never blocks completion) but renders distinctly. */
  planSkippedStages:  Record<string, string[]>;
  skipPlanStage:      (projectId: string, key: string) => void;
  unskipPlanStage:    (projectId: string, key: string) => void;
  /** Add a skip to the store ONLY (no plan.db write-through) — the poll uses this to rehydrate the
   *  durable skipped set (#2267) from plan.db on revisit without echoing it back. */
  markStageSkippedLocal: (projectId: string, key: string) => void;
  /** Collapse non-canonical section keys (e.g. "Tech stack" → "stack") for a project,
   *  merging content into the canonical key (and deduping confirmed keys) — repairs a gate
   *  stuck on a stale title-named section (#803). */
  canonicalizePlanStages: (projectId: string) => void;
  planAutomations:    Record<string, AutomationSuggestion[]>;
  /** Replace a project's automations with the DB-owned list (reflected by the section poll from
   *  `bsc plan automations`, #2009). */
  setPlanAutomations: (projectId: string, list: AutomationSuggestion[]) => void;
  clearPlanAutomations: (projectId: string) => void;
  // Modular planning stages (#512): per-project on/off + ordering of the planning
  // stages. Defaults (all-on, registry order) are resolved lazily via
  // defaultStageConfig, so an unset project behaves exactly as today.
  planStageConfig:    Record<string, StageConfig>;
  setStageEnabled:    (projectId: string, stageId: StageId, enabled: boolean) => void;
  reorderStages:      (projectId: string, order: StageId[]) => void;
  /** Wholesale-set a project's stage config (used to seed it from a blueprint). */
  setProjectStageConfig: (projectId: string, config: StageConfig) => void;
  /** Seed a NEW project with the dynamic-stages baseline (#1395): Discovery (`context`) only,
   *  every other stage off + lighting up additively from classification signals. Idempotent —
   *  a no-op once the project has a stage config, so it never clobbers an existing plan. */
  seedDiscoveryOnlyStages: (projectId: string) => void;
  // Blueprints (#513/#514): named, reusable configs — an ordered list of planning
  // sections, each owning its prompt module + pipelines. The active one seeds new
  // projects. Seeded with the starter library; persisted. Section/pipeline edits go
  // through setBlueprintStages (the component computes the new sections array).
  blueprints:         Blueprint[];
  activeBlueprintId:  string;
  setActiveBlueprint: (id: string) => void;
  // Which blueprint each project was last seeded/reset from (#647), keyed by project key.
  // Lets the planner detect when the selected blueprint differs from the project's and
  // offer to reset. Set on first seed + on an explicit blueprint switch.
  projectBlueprintId: Record<string, string>;
  setProjectBlueprintId: (projectId: string, blueprintId: string) => void;
  /** Which UI surface the `ui` stage renders for a project (#3783): "custom" = the in-app
   *  designer preview (PreviewPaneShell); "external" = the Claude-Design drop-files intake
   *  (FileIntakePane). The planner picks this at discovery; defaults to "custom" at the read site. */
  uiMode: Record<string, "custom" | "external">;
  setUiMode: (projectId: string, mode: "custom" | "external") => void;
  addBlueprint:       () => string;
  /** Promote a completed project's plan into a reusable blueprint (#3785); returns the new id. */
  generateBlueprint:  (projectKey: string) => string;
  duplicateBlueprint: (id: string) => string;
  updateBlueprintMeta: (id: string, patch: Partial<Omit<Blueprint, "id" | "sections">>) => void;
  setBlueprintStages: (id: string, sections: BlueprintStage[]) => void;
  /** Delete a blueprint; if it was active, the active id falls back to the first
   *  remaining (or the default). */
  removeBlueprint: (id: string) => void;
  /** Add an imported blueprint under a fresh id + fresh section uids (never overwrites
   *  an existing one). Returns the new id. */
  importBlueprint: (bp: Blueprint) => string;
  // Stage-pipeline run state (#528/#529): per-project, per-pipeline run status, keyed
  // projectKey -> stageUid -> state. Session-only (not persisted).
  stageRuns: Record<string, Record<string, StageRunState>>;
  setStageRun: (projectKey: string, stageUid: string, state: StageRunState) => void;
  // The current UI preview per project (#531): the render-preview pipeline writes the
  // bundled iframe srcdoc here; PlanPreviewPane renders it. `screen` names which screen
  // is showing (#546), so its approve button targets the right one. Session-only.
  stagePreview: Record<string, { srcDoc: string; mode: "2d" | "3d"; screen?: string } | null>;
  setStagePreview: (projectKey: string, value: { srcDoc: string; mode: "2d" | "3d"; screen?: string } | null) => void;
  // Per-screen UI approval (#544/#546). `uiScreens` is the set of screens the planner
  // has declared via <ui_preview> tags (the denominator); `uiApproved` is the names the
  // user has signed off in the preview pane (the numerator). The UI stage completes only
  // when every declared screen is approved. Both persisted — real approval signals.
  uiScreens: Record<string, string[]>;
  addUiScreen: (projectKey: string, screen: string) => void;
  uiApproved: Record<string, string[]>;
  setUiScreenApproved: (projectKey: string, screen: string, approved: boolean) => void;
  // Agent fleet — the parallel-execution plan (work streams + optional director +
  // the optimal concurrent session count). Persisted per project.
  planFleet:             Record<string, FleetPlan>;
  setPlanFleet:          (projectId: string, fleet: FleetPlan) => void;       // wholesale (from fleet.json poll)
  /** Per-project set of context-file names pinned in the project pane (overrides the
   *  confirmed-section default). projectId -> pinned file names. */
  pinnedContext:         Record<string, string[]>;
  togglePinnedContext:   (projectId: string, name: string) => void;
  addPlanAgentStream:    (projectId: string, stream: AgentStream) => void;    // merge-by-id (from inline tag)
  removePlanAgentStream: (projectId: string, id: string) => void;
  /** #289: assign an AgentProfile id to a stream (null clears). */
  setPlanAgentStreamProfile: (projectId: string, streamId: string, profileId: string | null) => void;
  /** #297: set one or more flow fields on a stream (merged into its resolved flow). */
  setPlanAgentStreamFlow: (projectId: string, streamId: string, patch: Partial<AgentFlow>) => void;
  /** #…: set a stream's per-agent LLM model (undefined clears it so the stream inherits the
   *  global `defaultModel`). Applied at fleet launch as `claude --model <tier>`. */
  setPlanAgentStreamModel: (projectId: string, streamId: string, model: ModelId | undefined) => void;
  /** #378: set a stream's per-stream integration-strategy override (undefined clears
   *  it so the stream inherits the fleet default). */
  setPlanAgentStreamStrategy: (projectId: string, streamId: string, strategy: IntegrationStrategy | undefined) => void;
  /** #2094: set (or clear, with null) the persona a stream launches as — resolves role/prompt/skills/
   *  model at fleet launch. */
  setPlanAgentStreamPersona: (projectId: string, streamId: string, personaId: string | null) => void;
  setPlanFleetMeta:      (projectId: string, recommended: number, reasoning: string, strategy?: IntegrationStrategy) => void;
  /** Per-project coordination-topology override (#…), set in the Permissions pane. Wins
   *  over the planner's fleet.json topology and survives a fleet re-poll. */
  planFleetTopology:     Record<string, Topology>;
  setPlanFleetTopology:  (projectId: string, topology: Topology) => void;
  /** Per-project director-drive override (#…), set in the Permissions pane alongside the
   *  topology. Wins over fleet.json's `director.drive` and survives a fleet re-poll. */
  planFleetDirectorDrive:    Record<string, DirectorDrive>;
  setPlanFleetDirectorDrive: (projectId: string, drive: DirectorDrive) => void;
  setPlanDirector:       (projectId: string, enabled: boolean, role?: string) => void;
  setPlanDirectorDrive:  (projectId: string, drive: DirectorDrive) => void;
  clearPlanFleet:        (projectId: string) => void;
  clearPlan:             (key: string) => void;
}
