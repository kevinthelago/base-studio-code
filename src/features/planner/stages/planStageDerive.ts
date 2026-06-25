// Map the live plan data into the normalized PlanStageState the stage gates read
// (#512). Pure + isolated from the giant Planning component so the categorization
// (which sections are "context" vs the structure anchor, core-topic confirmation)
// is unit-testable. The call site supplies the simpler primitives (repo/issue/fleet
// counts); this function owns the section categorization.

import { buildPlanStageState, type PlanStageState } from "./planStages";
import type { SectionState } from "../github/ghStructure";
import type { PlanSignals } from "./stageGate";

/** The universal baseline context topics a project requires when nothing else seeds the manifest
 *  (#1019). A blueprint may seed a different set via its context section's `requires`; the planner
 *  then adjusts it with `bsc-plan context require/unrequire`. */
export const CONTEXT_BASELINE = ["goal", "scope", "stack", "architecture", "users", "release"];

// datamodel.json contract
// Path:    ~/.base-studio-code/projects/<key>/datamodel.json
// Writer:  source-experience stream
// Reader:  planner-plumbing (this file) — absent artifact or missing fields read as false
// Shape (all fields optional at the top level; absent ⇒ false):
// {
//   "sourceReachable": boolean,  // source system is reachable and has been inventoried
//   "modelInferred":   boolean,  // entities, fields, and identity key have been proposed
//   "schemaRefined":   boolean,  // user has confirmed / revised the proposed schema
//   "mappingComplete": boolean,  // field-by-field source→model mapping is complete
//   "loadVerified":    boolean   // load run has been verified against expectations
// }

export interface DerivePlanStageInput {
  /** Every surfaced plan section with its state (from the dynamic section model). */
  sections: { k: string; state: SectionState }[];
  /** The project's required context topics (#1019) — the dynamic required-set from plan.db. The
   *  Context gate (#1028) passes once every required topic's `context/<topic>.md` has been written. */
  contextRequired: string[];
  repoCount: number;
  issueCount: number;
  fleetStreams: number;
  fleetProfilesComplete: boolean;
  automationsAck: boolean;
  skillsAck: boolean;
  requiresUi: boolean;
  ui: { approved: number; total: number };
  /** The user routed dropped design files to the project — completes the UI stage without a
   *  screen-preview approval pass (#837). */
  uiRouted?: boolean;
  /** User-facing capabilities defined in the Features stage (each becomes a stream). */
  features: { count: number; allConfirmed: boolean };
  /** Libraries locked in the dependency manifest (#1111) — `dependencies.json` entry count. */
  dependencies?: { count: number };
  /** Whether a data migration source pipeline is active for this project. Absent ⇒ false. */
  migrationSourceEnabled?: boolean;
  /** Parsed datamodel.json artifact from the source-experience stream. Absent ⇒ all-false. */
  datamodelArtifact?: {
    sourceReachable?: boolean;
    modelInferred?: boolean;
    schemaRefined?: boolean;
    mappingComplete?: boolean;
    loadVerified?: boolean;
  };
}

/**
 * The drafted-but-unconfirmed sections the focused pane's "approve & continue" confirms in ONE
 * click for the active stage (#807-followup). Confirming each discovery file individually was the
 * only way to satisfy the Context gate, but the focused pane has no per-file confirm control — so
 * a manual user was deadlocked. This collapses the per-file confirmation into a single per-stage
 * approval gesture.
 *
 * - **context** → nothing. Context files gate on GENERATION (#1028), not confirmation — they're
 *   done once written, so there's no per-file confirm step.
 * - **structure** → the `phases` roadmap anchor when it's drafted.
 * - other stages gate on counts (issues, fleet, …), not section confirmation ⇒ nothing to confirm.
 */
export function pendingStageConfirms(
  activeStageKey: string | undefined,
  sections: { k: string; state: SectionState }[],
): string[] {
  if (activeStageKey === "structure") {
    return sections.some((s) => s.k === "phases" && s.state === "drafted") ? ["phases"] : [];
  }
  return [];
}

/**
 * The section keys "approve & continue" must confirm for the active stage to advance (#954).
 *
 * A **gateless** ("informational") stage completes ONLY via its own `confirmed:<key>` signal — it has
 * no `gateRule`, so the structure/context discovery anchors (which feed a GATE) don't apply to it.
 * This is the common case for an IMPORTED blueprint, whose gateRules are stripped on import so EVERY
 * stage is gateless: confirm the stage itself. Without this the focused pane left the approve button
 * enabled (an empty gate reads as met) yet nothing advanced.
 *
 * A **gated** stage completes via its gate; confirm the drafted anchors its gate reads
 * ({@link pendingStageConfirms}: structure → phases, context → the core discovery files).
 */
export function stageConfirmKeys(
  activeStageKey: string | undefined,
  sections: { k: string; state: SectionState }[],
  activeHasGate: boolean,
  activeAlreadyConfirmed: boolean,
): string[] {
  if (!activeStageKey) return [];
  if (!activeHasGate) return activeAlreadyConfirmed ? [] : [activeStageKey];
  return pendingStageConfirms(activeStageKey, sections);
}

export function derivePlanStageState(input: DerivePlanStageInput): PlanStageState {
  // Context (#1019/#1028): the gate is driven by the project's DYNAMIC required-set, not a hardcoded
  // core, and it passes on GENERATION — a topic is "ready" once its `context/<topic>.md` exists
  // (section state leaves `pending`). No confirmation: the files are done when written. There must be
  // ≥1 required topic (an empty set can't pass, which also retires the old "absent ⇒ satisfied" trap).
  const byKey = new Map(input.sections.map((s) => [s.k, s.state]));
  const present = (topic: string) => {
    const st = byKey.get(topic);
    return st !== undefined && st !== "pending";
  };
  const total = input.contextRequired.length;
  const resolved = input.contextRequired.filter(present).length;
  const requiredContextReady = total > 0 && resolved >= total;

  const phasesConfirmed = byKey.get("phases") === "confirmed";

  const art = input.datamodelArtifact ?? {};
  return buildPlanStageState({
    context: { resolved, total, requiredContextReady },
    repoCount: input.repoCount,
    requiresUi: input.requiresUi,
    ui: { ...input.ui, routed: input.uiRouted ?? false },
    features: input.features,
    dependencies: { count: input.dependencies?.count ?? 0 },
    phasesConfirmed,
    issueCount: input.issueCount,
    fleet: { streams: input.fleetStreams, profilesComplete: input.fleetProfilesComplete },
    automationsAck: input.automationsAck,
    skillsAck: input.skillsAck,
    migrationSourceEnabled: input.migrationSourceEnabled ?? false,
    datamodel: {
      sourceReachable: art.sourceReachable ?? false,
      modelInferred:   art.modelInferred   ?? false,
      schemaRefined:   art.schemaRefined   ?? false,
      mappingComplete: art.mappingComplete  ?? false,
      loadVerified:    art.loadVerified     ?? false,
    },
  });
}

/**
 * Flatten the typed {@link PlanStageState} into the serializable {@link PlanSignals}
 * bag that declarative section gates read. This is the bridge between the app's live
 * state derivation and the data-driven gate evaluator — the published signal
 * vocabulary that built-in and cloud-distributed sections alike compose against.
 */
export function planStateToSignals(s: PlanStageState): PlanSignals {
  return {
    requiredContextReady: s.context.requiredContextReady,
    topicsResolved: s.context.resolved,
    topicsTotal: s.context.total,
    repoCount: s.repoCount,
    requiresUi: s.requiresUi,
    screensApproved: s.ui.approved,
    screensTotal: s.ui.total,
    // UI completes when the design is routed to the project OR every screen preview is
    // approved (#837) — the gate reads this combined signal.
    uiDone: s.ui.routed || (s.ui.total > 0 && s.ui.approved >= s.ui.total),
    featuresDefined: s.features.count,
    featuresConfirmed: s.features.allConfirmed,
    // Dependencies (#1111): the manifest gate passes once the planner has locked ≥1 library.
    dependenciesDefined: s.dependencies.count,
    phasesConfirmed: s.phasesConfirmed,
    issueCount: s.issueCount,
    fleetStreams: s.fleet.streams,
    profilesComplete: s.fleet.profilesComplete,
    automationsAck: s.automationsAck,
    skillsAck: s.skillsAck,
    // datamodel.json signals (source-experience stream writes the artifact; absent ⇒ false).
    sourceReachable: s.datamodel.sourceReachable,
    modelInferred:   s.datamodel.modelInferred,
    schemaRefined:   s.datamodel.schemaRefined,
    mappingComplete: s.datamodel.mappingComplete,
    loadVerified:    s.datamodel.loadVerified,
  };
}
