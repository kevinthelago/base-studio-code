// usePlanFocusedPane (#1490/#652, extracted from Planning.tsx) — the focused-pane SELECTION and its
// derived advance-bar/pill/prompt-help. Owns `focusSel` (null = auto-follow the active stage; a
// number = a user-pinned selection), resets it on a project/blueprint switch, and derives:
//   • focusSelectedIdx — the clamped resolved index (selection ?? active).
//   • focusFooter — the advance-bar action (footerAction → resolveFooter); the primary is lit by
//     pendingConfirm, and a uniform Skip control (skipEnabled) advances past a stage — always on an
//     optional stage, and on a required stage only with gate-override on (#1285/#2533).
//   • focusPill — the selected stage's gate pill.
//   • focusStagePrompts — the injectable prompts for the SELECTED stage (the header "?" helper).
// The JSX wires `setFocusSel` into onSelect/onBack/onSkip/onPrimary. Behavior-preserving move — the
// state, reset effect, and derivations are verbatim; only their call-site moved below usePlanGates +
// usePlanConfirmations (whose `pendingConfirm` the footer reads). The skip/confirm/publish actions
// stay in the component (they close over usePlanConfirmations + usePlanPublish).
import { useState, useEffect, useMemo } from "react";
import { clampIndex, gatePill, footerAction, resolveFooter, type stagesFrom } from "../stages/focusedPlan";
import { stagePrompts } from "./plannerConductor";
import type { BlueprintStage } from "../stages/blueprints";

type Stages = ReturnType<typeof stagesFrom>;

export interface PlanFocusedPaneOpts {
  /** The blueprint-driven focused-pane stages (from usePlanGates). */
  stages: Stages;
  /** The live active-stage index (from usePlanGates). */
  focusActiveIdx: number;
  /** Whether the whole plan's gate is met (from usePlanGates). */
  planComplete: boolean;
  /** Whether the active stage's gate is satisfied (from usePlanGates). */
  focusGateReady: boolean;
  /** The active stage's drafted-but-unconfirmed sections (from usePlanConfirmations) — lights the
   *  "approve & continue" footer. */
  pendingConfirm: string[];
  /** Gate-override toggle (#1285) — allows force-advancing a blocking gate. */
  allowGateOverride: boolean;
  /** The blueprint's stages — resolves the selected stage's injectable prompts by key (#815). */
  planSecs: BlueprintStage[];
  /** #2121 — the active UI stage's design is missing or stale (not routed / changed since routed),
   *  so its primary footer action becomes "route design" instead of "approve & continue". */
  uiNeedsRoute: boolean;
  /** Selection resets when either changes. */
  effectiveProjectId: string;
  effectiveBlueprintId: string;
}

export function usePlanFocusedPane(opts: PlanFocusedPaneOpts) {
  const {
    stages, focusActiveIdx, planComplete, focusGateReady, pendingConfirm,
    allowGateOverride, planSecs, effectiveProjectId, effectiveBlueprintId, uiNeedsRoute,
  } = opts;

  // The SELECTION — auto-follows the active stage (`focusSel` null) or pins to a user pick; reset on
  // project/blueprint switch. `stages`/`focusActiveIdx` come from usePlanGates.
  const [focusSel, setFocusSel] = useState<number | null>(null);
  useEffect(() => { setFocusSel(null); }, [effectiveProjectId, effectiveBlueprintId]);
  const focusSelectedIdx = clampIndex(focusSel ?? focusActiveIdx, stages.length);

  // Whether the active stage is OPTIONAL — drives Skip actionability (#2533): an optional stage is
  // always skippable; a required one only when gate-override is on. The Skip CONTROL itself now shows
  // on every active stage (footerAction), so the footer reads as a uniform Continue + Skip pair.
  const activeOptional = stages[focusActiveIdx]?.optional === true;
  // #2121: on the active UI stage with missing/stale design, the primary action routes the design.
  const routeDesign = stages[focusActiveIdx]?.key === "ui" && uiNeedsRoute;
  const footerRaw = footerAction(focusSelectedIdx, focusActiveIdx, planComplete, focusGateReady, routeDesign);
  // Let "approve & continue" light up as soon as there are drafted sections to confirm (clicking
  // confirms them, see onPrimary); resolveFooter also sets `skipEnabled` from optional + override.
  const focusFooter = resolveFooter(footerRaw, pendingConfirm.length, allowGateOverride, activeOptional);
  const focusSelStage = stages[focusSelectedIdx];
  const focusPill = focusSelStage ? gatePill(focusSelStage) : "wait";
  // Injectable prompts for the SELECTED stage — the header "?" helper lists them and the user picks
  // one to inject (the app no longer auto-injects). Resolve the section BY KEY (stages is a filtered
  // subset of planSecs, #815).
  const focusStagePrompts = useMemo(
    () => stagePrompts(planSecs.find(s => s.key === focusSelStage?.key)),
    [planSecs, focusSelStage]);

  return { setFocusSel, focusSelectedIdx, focusPill, focusFooter, focusStagePrompts };
}
