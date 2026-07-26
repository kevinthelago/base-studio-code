// usePlannerBlueprint (#1474) — the planner's blueprint lifecycle derivation (orientation),
// extracted verbatim from Planning.tsx.

import { useMemo } from "react";
import { type Blueprint } from "../stages/blueprints";
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
}

export function usePlannerBlueprint(deps: BlueprintDeps): PlannerBlueprint {
  const { blueprints, effectiveBlueprintId, isExisting } = deps;

  const activeBlueprint = useMemo(() => blueprints.find(b => b.id === effectiveBlueprintId), [blueprints, effectiveBlueprintId]);
  // #1286: the planner's orientation (its intro greeting AND its generated CLAUDE.md spec) follows
  // the blueprint's lifecycle MODE — an operate-mode blueprint (transform/harden/maintain) takes the
  // "existing repos" orientation even on a fresh draft, where the bare `isExisting` (saved-project)
  // proxy would mis-greet it as a new greenfield project. Plain `isExisting` stays for the
  // drafting/expanding UI labels (genuinely about save-state).
  const treatAsExisting = plannerTreatAsExisting({ isSaved: isExisting, mode: activeBlueprint?.mode });

  return { activeBlueprint, treatAsExisting };
}
