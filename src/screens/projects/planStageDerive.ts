// Map the live plan data into the normalized PlanStageState the stage gates read
// (#512). Pure + isolated from the giant Planning component so the categorization
// (which sections are "context" vs the structure anchor, core-topic confirmation)
// is unit-testable. The call site supplies the simpler primitives (repo/issue/fleet
// counts); this function owns the section categorization.

import { buildPlanStageState, type PlanStageState } from "./planStages";
import { parseSectionKey } from "./planSections";
import type { SectionState } from "./ghStructure";
import type { PlanSignals } from "./stageGate";

/** The four discovery topics the planner template always confirms. */
const CORE = ["goal", "scope", "stack", "architecture"];

export interface DerivePlanStageInput {
  /** Every surfaced plan section with its state (from the dynamic section model). */
  sections: { k: string; state: SectionState }[];
  repoCount: number;
  issueCount: number;
  fleetStreams: number;
  fleetProfilesComplete: boolean;
  automationsAck: boolean;
  skillsAck: boolean;
  requiresUi: boolean;
  ui: { approved: number; total: number };
}

export function derivePlanStageState(input: DerivePlanStageInput): PlanStageState {
  // Context = project-tier discovery sections, excluding the structure anchor
  // (`phases`). Skipped topics aren't surfaced as sections, so they're simply
  // absent — i.e. resolved by omission — which is the intended behavior.
  const contextSections = input.sections.filter(
    (s) => parseSectionKey(s.k).tier === "project" && s.k !== "phases",
  );
  const total = contextSections.length;
  const resolved = contextSections.filter((s) => s.state === "confirmed").length;

  // A core topic is OK if confirmed or absent (skipped); a present-but-unconfirmed
  // core topic blocks context completion.
  const byKey = new Map(input.sections.map((s) => [s.k, s.state]));
  const coreConfirmed = CORE.every((k) => {
    const st = byKey.get(k);
    return st === undefined || st === "confirmed";
  });
  const phasesConfirmed = byKey.get("phases") === "confirmed";

  return buildPlanStageState({
    context: { resolved, total, coreConfirmed },
    repoCount: input.repoCount,
    requiresUi: input.requiresUi,
    ui: input.ui,
    phasesConfirmed,
    issueCount: input.issueCount,
    fleet: { streams: input.fleetStreams, profilesComplete: input.fleetProfilesComplete },
    automationsAck: input.automationsAck,
    skillsAck: input.skillsAck,
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
    coreConfirmed: s.context.coreConfirmed,
    topicsResolved: s.context.resolved,
    topicsTotal: s.context.total,
    repoCount: s.repoCount,
    requiresUi: s.requiresUi,
    screensApproved: s.ui.approved,
    screensTotal: s.ui.total,
    phasesConfirmed: s.phasesConfirmed,
    issueCount: s.issueCount,
    fleetStreams: s.fleet.streams,
    profilesComplete: s.fleet.profilesComplete,
    automationsAck: s.automationsAck,
    skillsAck: s.skillsAck,
  };
}
