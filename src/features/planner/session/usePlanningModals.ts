// usePlanningModals (#1642) — the planner's modal open/close state, extracted verbatim from
// Planning.tsx. Owns the clear-plan confirmation flag and the blueprint-update modal, including the
// auto-open state machine (#827/#1296): reset the auto-shown latch on a project switch, then open the
// modal exactly once when a true blueprint/template VERSION mismatch is detected over an existing plan
// (`shouldAutoOpenBlueprintModal` compares only the `v{version}` signature prefix, NOT the broad
// `contextStale` flag — benign setup tweaks keep driving the quiet "context updated" badge instead).
//
// STRICTLY behaviour-preserving: the two effects and their dependency arrays are moved unchanged.

import { useState, useEffect, type Dispatch, type SetStateAction } from "react";
import { shouldAutoOpenBlueprintModal } from "../stages/blueprints";

export interface PlanningModalsDeps {
  effectiveProjectId: string;
  /** The live context signature (from compute_context_signature); null until resolved. */
  currentSig: string | null;
  /** The baseline signature setup_workspaces last wrote; null until read. */
  lastSetupSig: string | null;
  /** Whether the project already has plan sections (gates the destructive auto-open). */
  hasExistingPlan: boolean;
}

export interface PlanningModals {
  /** Clear-plan confirmation dialog (#664). */
  showClearConfirm: boolean;
  setShowClearConfirm: Dispatch<SetStateAction<boolean>>;
  /** Blueprint-update modal (#827). */
  showBlueprintModal: boolean;
  setShowBlueprintModal: Dispatch<SetStateAction<boolean>>;
}

export function usePlanningModals({
  effectiveProjectId, currentSig, lastSetupSig, hasExistingPlan,
}: PlanningModalsDeps): PlanningModals {
  const [showClearConfirm, setShowClearConfirm] = useState(false); // clear-plan confirmation modal (#…)

  // Blueprint-update modal (#827): when a project is opened whose blueprint/planner-template
  // VERSION differs from the one it was seeded with AND it already has a plan, surface a modal so
  // the user explicitly chooses go-back / restart / keep — rather than the old silent refresh,
  // which restarted the planner into a destructive reconciliation that deleted plan files.
  //
  // #1296: gate the auto-open on a true template-version mismatch (`shouldAutoOpenBlueprintModal`,
  // which compares only the `v{version}` prefix of the two signatures), NOT the broad `contextStale`
  // flag. `contextStale` also flips on benign setup tweaks (link a repo, enable/
  // disable a stage) — those must keep driving only the quiet "context updated · refresh" badge
  // below, never this destructive restart dialog.
  const [showBlueprintModal, setShowBlueprintModal] = useState(false);
  const [bpModalAutoShown, setBpModalAutoShown] = useState(false);
  useEffect(() => { setBpModalAutoShown(false); setShowBlueprintModal(false); }, [effectiveProjectId]);
  useEffect(() => {
    if (shouldAutoOpenBlueprintModal({ currentSig, baselineSig: lastSetupSig, hasExistingPlan, alreadyShown: bpModalAutoShown })) {
      setShowBlueprintModal(true);
      setBpModalAutoShown(true);
    }
  }, [currentSig, lastSetupSig, hasExistingPlan, bpModalAutoShown]);

  return { showClearConfirm, setShowClearConfirm, showBlueprintModal, setShowBlueprintModal };
}
