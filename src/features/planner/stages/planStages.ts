// Modular planning stages (#512/#515). The registry is the single source of
// truth for the canonical, ordered stage set and each stage's stable `id` — what
// the config/ordering layer (defaultStageConfig / enabledOrderedStages) and the
// blueprint seeder key off.
//
// Gating is NOT here. A stage's "done-ness" and applicability are declarative DATA
// — the `gateRule` / `appliesWhen` carried by each stage's prompt JSON
// (`src-tauri/data/stages/*.json`), evaluated by {@link evalGate} in stageGate.ts
// against the flat signal bag {@link planStateToSignals} publishes. That makes a
// stage authorable, shareable, and WAN-distributable as data; the executable code
// gates that used to live here (#1598) were dead duplicates that had drifted from
// the authoritative JSON, so they were removed.
//
// Everything here is pure — no React/Tauri — so the registry + config logic stays
// unit-testable, and both the bar and the Rust prompt assembler key off the same ids.
//
// The registry DATA (the ordered stage set + each stage's label/optional/deps/defaultEnabled) is
// externalized to `@data/planner/stage-registry.json` (#2027 P1) — editable without touching code and
// part of the exportable app-config bundle. (It lives OUTSIDE `@data/stages/`, whose per-stage prompt
// JSONs are loaded by a `@data/stages/*.json` glob that would otherwise grab the registry.) This
// module keeps the TYPES + the config logic (defaultStageConfig / enabledOrderedStages / STAGE_BY_ID).

import stageRegistryEmbedded from "@data/planner/stage-registry.json";
import { overlayFile } from "@/shared/lib/core/configOverrides";

// The config-dir copy (#2047) overlays the embedded default — editable without a rebuild.
const stageRegistry = overlayFile("planner/stage-registry.json", stageRegistryEmbedded);

/** All valid stage identifiers, in pipeline order.
 *  `load` is signal-only — it has no PLAN_STAGES entry and is never shown in the bar,
 *  but exists in the union so other stages and signal consumers can reference it by name. */
export type StageId =
  | "discovery"
  | "deployment"
  | "source"
  | "features"
  | "ui"
  | "streams"
  | "automations"
  | "skills"
  | "load";

/**
 * Normalized snapshot of live plan progress. A later slice builds this from the live
 * plan data (sections, repos, fleet, …) via {@link buildPlanStageState}, and
 * {@link planStateToSignals} (planStageDerive.ts) flattens it into the serializable
 * {@link PlanSignals} bag the declarative JSON gates read. Use buildPlanStageState to
 * construct one with safe defaults for any field not yet known.
 */
export interface PlanStageState {
  /** Discovery progress (#1019/#1028): required topics written (`resolved`) vs required total, plus
   *  `requiredDiscoveryReady` — every REQUIRED topic's file generated (≥1 required). No confirmation. */
  discovery: { resolved: number; total: number; requiredDiscoveryReady: boolean };
  /** Repositories linked to the project. */
  repoCount: number;
  /** Whether the project needs a UI at all — drives the UI stage's applicability. */
  requiresUi: boolean;
  /** Required screens approved vs total (only meaningful when requiresUi). `routed` is set
   *  when the user routes dropped design files to the project — an alternative completion to
   *  approving screen previews (#837). */
  ui: { approved: number; total: number; routed?: boolean };
  /** Features: how many user-facing capabilities are defined, and whether all are
   *  confirmed. Each feature becomes a fleet stream; the Plan stage reads them. */
  features: { count: number; allConfirmed: boolean };
  /** Dependencies (#1111/#1191): how many libraries the planner has locked in the dependency manifest
   *  (plan.db, via `bsc-plan deps set`). The Dependencies gate passes once ≥1 is defined. */
  dependencies: { count: number };
  issueCount: number;
  /** Fleet: streams defined, and each has a profile/flow set. */
  fleet: { streams: number; profilesComplete: boolean };
  /** Automations reviewed/acknowledged (may legitimately be zero). */
  automationsAck: boolean;
  /** Skills assigned/acknowledged (may legitimately be zero). */
  skillsAck: boolean;
  /** Whether a migration source pipeline is active for this project — drives the source
   *  stage's applicability. False for projects with no data migration component. */
  migrationSourceEnabled: boolean;
  /** Signals derived from datamodel.json (written by the source-experience stream).
   *  Absent artifact reads as all-false. */
  datamodel: {
    sourceReachable: boolean;
    modelInferred: boolean;
    schemaRefined: boolean;
    mappingComplete: boolean;
    loadVerified: boolean;
  };
}

export interface Stage {
  id: StageId;
  /** Short display label shown in the PlanStageBar. */
  label: string;
  /** One-line description of what this stage produces (shown in Blueprint editor). */
  description: string;
  /** Whether the stage can be toggled off in a Blueprint.
   *  Only `discovery` is required (optional: false). All other stages — including
   *  `structure` — can be omitted by blueprints that don't need them (e.g. a
   *  refactor/cleanup blueprint skips the feature workshop). */
  optional: boolean;
  /** Whether this stage produces a visible output file the app polls for
   *  (e.g. phases.json, fleet.json). Informational only — drives tooltip copy. */
  hasOutputFile: boolean;
  /** Prerequisite stages (documentation of the canonical ordering). Live dependency
   *  gating is the blueprint section's declarative `deps`, not this field. */
  dependsOn: StageId[];
  defaultEnabled: boolean;
}

/** Per-project (or per-blueprint) on/off + ordering of the stages (#512). */
export interface StageConfig {
  enabled: Record<StageId, boolean>;
  order: StageId[];
}

// ── The canonical stage registry ─────────────────────────────────────────────
// From `@data/planner/stage-registry.json`. Ordering rationale baked into that file's order: `ui`
// sits after `features` so its Claude Design kickoff can reference the defined capabilities
// (#825/#1404); `deployment`/`streams` are the collapsed repos+deploy / structure+permissions stages
// (#1914). `dependsOn` DOCUMENTS the real prerequisites — runtime gating reads each stage's
// declarative `@data/stages/<id>.json` `gateRule`/`deps`, not this registry. (The signal-only `load`
// sibling has NO registry entry — it never shows in the bar — but exists in the StageId union.)
export const PLAN_STAGES: Stage[] = stageRegistry as Stage[];

export const STAGE_BY_ID: Record<StageId, Stage> = Object.fromEntries(
  PLAN_STAGES.map((s) => [s.id, s]),
) as Record<StageId, Stage>;

/** All-on config in the registry's default order — reproduces today's behavior. */
export function defaultStageConfig(): StageConfig {
  return {
    enabled: Object.fromEntries(PLAN_STAGES.map((s) => [s.id, s.defaultEnabled])) as Record<StageId, boolean>,
    order: PLAN_STAGES.map((s) => s.id),
  };
}

/**
 * The dynamic-stages seed (#1395 phase 1): ONLY Discovery is enabled; every other
 * stage starts OFF and lights up additively as Discovery's classification signals select it.
 * The full registry order is preserved so an additively-enabled stage slots into its place.
 * Distinct from {@link defaultStageConfig} (all-on), which reproduces the legacy blueprint behavior;
 * this is the source-of-truth seed a new project gets once blueprints stop hand-picking the set.
 */
export function discoveryOnlyStageConfig(): StageConfig {
  return {
    enabled: Object.fromEntries(PLAN_STAGES.map((s) => [s.id, s.id === "discovery"])) as Record<StageId, boolean>,
    order: PLAN_STAGES.map((s) => s.id),
  };
}

/** Fill a partial snapshot with safe defaults so callers needn't specify every field. */
export function buildPlanStageState(p: Partial<PlanStageState> = {}): PlanStageState {
  return {
    discovery: p.discovery ?? { resolved: 0, total: 0, requiredDiscoveryReady: false },
    repoCount: p.repoCount ?? 0,
    requiresUi: p.requiresUi ?? false,
    ui: p.ui ?? { approved: 0, total: 0, routed: false },
    features: p.features ?? { count: 0, allConfirmed: false },
    dependencies: p.dependencies ?? { count: 0 },
    issueCount: p.issueCount ?? 0,
    fleet: p.fleet ?? { streams: 0, profilesComplete: false },
    automationsAck: p.automationsAck ?? false,
    skillsAck: p.skillsAck ?? false,
    migrationSourceEnabled: p.migrationSourceEnabled ?? false,
    datamodel: p.datamodel ?? {
      sourceReachable: false,
      modelInferred: false,
      schemaRefined: false,
      mappingComplete: false,
      loadVerified: false,
    },
  };
}

/** The enabled stages, in the configured order (what the bar renders). */
export function enabledOrderedStages(cfg: StageConfig): Stage[] {
  return cfg.order.filter((id) => cfg.enabled[id]).map((id) => STAGE_BY_ID[id]).filter(Boolean);
}
