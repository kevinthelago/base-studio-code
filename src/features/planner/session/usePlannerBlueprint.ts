// usePlannerBlueprint (#1474) — the planner's blueprint lifecycle derivations (orientation + the
// switch-blueprint affordance), extracted verbatim from Planning.tsx.

import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { canChangeBlueprint, canSwitchBlueprint, type Blueprint } from "../stages/blueprints";
import { plannerTreatAsExisting } from "./plannerIntro";

interface BlueprintDeps {
  blueprints: Blueprint[];
  effectiveBlueprintId: string;
  /** Whether the project is published (activeProjectId set) — the save-state proxy. */
  isExisting: boolean;
}

export interface PlannerBlueprint {
  activeBlueprint: Blueprint | undefined;
  treatAsExisting: boolean;
  switchTargets: Blueprint[];
  canSwitch: boolean;
  switchOpen: boolean;
  setSwitchOpen: Dispatch<SetStateAction<boolean>>;
}

export function usePlannerBlueprint(deps: BlueprintDeps): PlannerBlueprint {
  const { blueprints, effectiveBlueprintId, isExisting } = deps;

  const activeBlueprint = useMemo(() => blueprints.find(b => b.id === effectiveBlueprintId), [blueprints, effectiveBlueprintId]);
  // #1286: the planner's orientation (its intro greeting AND its generated CLAUDE.md spec) follows
  // the blueprint's lifecycle MODE — an operate-mode blueprint (transform/harden/maintain) takes the
  // "existing repos" orientation even on a fresh draft or right after a lifecycle switch, where the
  // bare `isExisting` (saved-project) proxy would mis-greet it as a new greenfield project. Plain
  // `isExisting` stays for the drafting/expanding UI labels (genuinely about save-state).
  const treatAsExisting = plannerTreatAsExisting({ isSaved: isExisting, mode: activeBlueprint?.mode });
  // Blueprint switching (#1281): any project blueprint may switch to any OTHER one — the
  // reset/keep/export confirmation modal is the safety, not a category rule. Offer every other
  // blueprint as a target.
  const switchTargets = useMemo(
    () => blueprints.filter(b => canSwitchBlueprint(activeBlueprint, b)),
    [blueprints, activeBlueprint]);
  const canSwitch = canChangeBlueprint(activeBlueprint) && switchTargets.length > 0;
  const [switchOpen, setSwitchOpen] = useState(false);

  return { activeBlueprint, treatAsExisting, switchTargets, canSwitch, switchOpen, setSwitchOpen };
}
