// usePlanConfirmations (#1775, extracted from Planning.tsx) — the stage gate-confirm/skip logic:
//   • pendingConfirm — the active stage's drafted sections that "approve & continue" confirms in one
//     click (plus the Features one-click once every feature is populated).
//   • confirmStageKeys — the single stage-completion primitive (#1068): confirm each pending section
//     + tell the planner to continue. Shared by the manual button, the autopilot, and auto-complete.
//   • auto-advance effect (#1068) — when the global flag is on, confirm the ready set after a beat.
//   • onSkipStage (#921) — skip the active optional stage + tell the planner to move on.
import { useMemo, useCallback, useEffect, useRef } from "react";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { titleForTopic, FEATURES_KEY } from "../stages/planTopics";
import { buildSectionConfirmMessage, buildSectionSkipMessage } from "./planningSession";
import { stageConfirmKeys } from "../stages/planStageDerive";
import { featuresAwaitingConfirm } from "../issues/featureList";
import { shouldAutoCompleteGate } from "../stages/focusedPlan";
import type { phasesFrom } from "../stages/focusedPlan";
import type { Section } from "../github/ghStructure";
import type { BlueprintStage } from "../stages/blueprints";

type Phases = ReturnType<typeof phasesFrom>;

export function usePlanConfirmations(opts: {
  phases: Phases;
  focusActiveIdx: number;
  sections: Section[];
  planSecs: BlueprintStage[];
  confirmedSet: Set<string>;
  featureState: Parameters<typeof featuresAwaitingConfirm>[0];
  featureCycle: string[];
  effectiveProjectId: string;
  paneId: string;
  confirmPlanSection: (projectId: string, key: string) => void;
  skipPlanSection: (projectId: string, key: string) => void;
  autoCompleteGates: boolean;
  /** autoPlanWithClaude && llmHasKey — the autopilot is running (and owns confirmation). */
  autoPlanActive: boolean;
}) {
  const {
    phases, focusActiveIdx, sections, planSecs, confirmedSet, featureState, featureCycle,
    effectiveProjectId, paneId, confirmPlanSection, skipPlanSection, autoCompleteGates, autoPlanActive,
  } = opts;

  // The active stage's drafted sections "approve & continue" confirms in one click (#807-followup)
  // — so the user approves a whole stage at once. Empty ⇒ nothing pending (the gate drives the button).
  const pendingConfirm = useMemo(() => {
    const activeKey = phases[focusActiveIdx]?.key;
    const activeSec = activeKey ? planSecs.find((s) => s.key === activeKey) : undefined;
    const base = stageConfirmKeys(activeKey, sections, !!activeSec?.gateRule, !!activeKey && confirmedSet.has(activeKey));
    // Features (#plan-db): once every feature in the roster is populated, offer the one-click confirm
    // that completes the stage. Until then the gate holds, so a single feature can't auto-advance.
    if (activeKey === FEATURES_KEY && featuresAwaitingConfirm(featureState, confirmedSet.has(FEATURES_KEY)) && featureCycle.length === 0) {
      return base.includes(FEATURES_KEY) ? base : [...base, FEATURES_KEY];
    }
    return base;
  }, [phases, focusActiveIdx, sections, planSecs, confirmedSet, featureState, featureCycle]);

  // The single stage-completion primitive (#1068): confirm each pending section + tell the planner to
  // continue. One path every gate advances through, so behaviour stays identical whether the user
  // clicks, the autopilot drives, or a gate self-advances.
  const confirmStageKeys = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    for (const k of keys) confirmPlanSection(effectiveProjectId, k);
    const name = keys.map((k) => titleForTopic(k)).join(", ") || "section";
    fireInvoke("pty_write", { paneId, data: buildSectionConfirmMessage(name) + "\r" }, console.error);
  }, [effectiveProjectId, paneId, confirmPlanSection]);

  // Auto-advance gates (#1068): when the global flag is on and the ACTIVE stage has drafted sections
  // awaiting confirmation, confirm them automatically after a short beat — the same action the
  // "approve & continue" button performs. Default off. Steps aside while the autopilot runs. The ref
  // stops a ready set from being re-confirmed on every render.
  const autoConfirmRef = useRef<string>("");
  useEffect(() => {
    if (!shouldAutoCompleteGate(autoCompleteGates, autoPlanActive, pendingConfirm)) return;
    const key = `${effectiveProjectId}|${pendingConfirm.join(",")}`;
    if (autoConfirmRef.current === key) return;
    const t = setTimeout(() => {
      autoConfirmRef.current = key;
      confirmStageKeys(pendingConfirm);
    }, 800);
    return () => clearTimeout(t);
  }, [autoCompleteGates, autoPlanActive, pendingConfirm, effectiveProjectId, confirmStageKeys]);

  // The user deliberately skips the active optional stage (#921): resolve its gate + tell the planner.
  const onSkipStage = useCallback(() => {
    const phase = phases[focusActiveIdx];
    if (!phase) return;
    skipPlanSection(effectiveProjectId, phase.key);
    fireInvoke("pty_write", { paneId, data: buildSectionSkipMessage(phase.name) + "\r" }, console.error);
  }, [phases, focusActiveIdx, skipPlanSection, effectiveProjectId, paneId]);

  return { pendingConfirm, confirmStageKeys, onSkipStage };
}
