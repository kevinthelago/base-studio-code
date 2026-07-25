// usePlannerBlueprint (#1474) — the planner's blueprint/authoring lifecycle derivations, extracted
// verbatim from Planning.tsx. These pure memos previously sat INSIDE the gate-signals region; pulling
// them out de-interleaves that region so usePlanGates becomes a clean, contiguous extraction next.
// The gate `signals` memo (which stays in Planning) consumes this hook's `isAuthoring`/`authoringSig`.

import { useMemo } from "react";
import { isAuthoringBlueprint, authoringSignals, type Blueprint } from "../stages/blueprints";
import { plannerTreatAsExisting } from "./plannerIntro";
import { buildSkillLibrary } from "../blueprints/blueprintSkills";
import { buildMcpLibrary } from "../blueprints/blueprintMcp";

interface BlueprintDeps {
  blueprints: Blueprint[];
  effectiveBlueprintId: string;
  /** Whether the project is published (activeProjectId set) — the save-state proxy. */
  isExisting: boolean;
  planAuthoredBlueprint: Record<string, Blueprint>;
  effectiveProjectId: string;
  skillDefs: Parameters<typeof buildSkillLibrary>[0];
  mcpServers: Parameters<typeof buildMcpLibrary>[0];
}

export interface PlannerBlueprint {
  activeBlueprint: Blueprint | undefined;
  isAuthoring: boolean;
  treatAsExisting: boolean;
  authoredBp: Blueprint | undefined;
  authoringSig: ReturnType<typeof authoringSignals>;
  authorSkillLib: ReturnType<typeof buildSkillLibrary>;
  authorMcpLib: ReturnType<typeof buildMcpLibrary>;
}

export function usePlannerBlueprint(deps: BlueprintDeps): PlannerBlueprint {
  const { blueprints, effectiveBlueprintId, isExisting, planAuthoredBlueprint, effectiveProjectId, skillDefs, mcpServers } = deps;

  // Blueprint-authoring lifecycle (#923): this project DESIGNS a blueprint (the deliverable) rather
  // than building software. The in-progress blueprint arrives via the planner's <blueprint> tag.
  const activeBlueprint = useMemo(() => blueprints.find(b => b.id === effectiveBlueprintId), [blueprints, effectiveBlueprintId]);
  const isAuthoring = isAuthoringBlueprint(activeBlueprint);
  // #1286: the planner's orientation (its intro greeting AND its generated CLAUDE.md spec) follows
  // the blueprint's lifecycle MODE — an operate-mode blueprint (transform/harden/maintain) takes the
  // "existing repos" orientation even on a fresh draft or right after a lifecycle switch, where the
  // bare `isExisting` (saved-project) proxy would mis-greet it as a new greenfield project. Plain
  // `isExisting` stays for the drafting/expanding UI labels (genuinely about save-state).
  const treatAsExisting = plannerTreatAsExisting({ isSaved: isExisting, mode: activeBlueprint?.mode });
  const authoredBp = planAuthoredBlueprint[effectiveProjectId];
  // Signals the authoring stages' gates read (name+category, stage count, validity).
  const authoringSig = useMemo(() => authoringSignals(authoredBp), [authoredBp]);
  // Pickable libraries for the Capabilities stage's skill + MCP pickers.
  const authorSkillLib = useMemo(() => buildSkillLibrary(skillDefs), [skillDefs]);
  const authorMcpLib = useMemo(() => buildMcpLibrary(mcpServers), [mcpServers]);

  return { activeBlueprint, isAuthoring, treatAsExisting, authoredBp, authoringSig, authorSkillLib, authorMcpLib };
}
