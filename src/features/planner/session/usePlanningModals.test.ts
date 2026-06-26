// #1642: usePlanningModals owns the planner's modal open/close state. These tests pin the
// blueprint-update auto-open state machine (#827/#1296): it opens exactly once on a true
// template-VERSION mismatch over an existing plan, and resets on a project switch.

import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePlanningModals, type PlanningModalsDeps } from "./usePlanningModals";

const base: PlanningModalsDeps = {
  effectiveProjectId: "proj",
  currentSig: null,
  lastSetupSig: null,
  hasExistingPlan: false,
};

describe("usePlanningModals", () => {
  it("starts with both modals closed", () => {
    const { result } = renderHook((p: PlanningModalsDeps) => usePlanningModals(p), { initialProps: base });
    expect(result.current.showClearConfirm).toBe(false);
    expect(result.current.showBlueprintModal).toBe(false);
  });

  it("auto-opens the blueprint modal on a template-version mismatch with an existing plan", () => {
    const { result } = renderHook((p: PlanningModalsDeps) => usePlanningModals(p), {
      // currentSig template version `v2` differs from baseline `v1` (prefix before `|`).
      initialProps: { ...base, currentSig: "v2|x", lastSetupSig: "v1|x", hasExistingPlan: true },
    });
    expect(result.current.showBlueprintModal).toBe(true);
  });

  it("does NOT auto-open for a benign change (same template version, only repos differ)", () => {
    const { result } = renderHook((p: PlanningModalsDeps) => usePlanningModals(p), {
      initialProps: { ...base, currentSig: "v1|a", lastSetupSig: "v1|b", hasExistingPlan: true },
    });
    expect(result.current.showBlueprintModal).toBe(false);
  });

  it("does NOT auto-open when there is no existing plan to protect", () => {
    const { result } = renderHook((p: PlanningModalsDeps) => usePlanningModals(p), {
      initialProps: { ...base, currentSig: "v2|x", lastSetupSig: "v1|x", hasExistingPlan: false },
    });
    expect(result.current.showBlueprintModal).toBe(false);
  });

  it("stays closed after a manual dismiss even though the mismatch persists (once-per-open guard)", () => {
    const props = { ...base, currentSig: "v2|x", lastSetupSig: "v1|x", hasExistingPlan: true };
    const { result, rerender } = renderHook((p: PlanningModalsDeps) => usePlanningModals(p), { initialProps: props });
    expect(result.current.showBlueprintModal).toBe(true);
    act(() => result.current.setShowBlueprintModal(false));
    rerender(props); // same mismatch — must not re-open
    expect(result.current.showBlueprintModal).toBe(false);
  });

  it("re-arms the auto-open latch on a project switch", () => {
    const props = { ...base, currentSig: "v2|x", lastSetupSig: "v1|x", hasExistingPlan: true };
    const { result, rerender } = renderHook((p: PlanningModalsDeps) => usePlanningModals(p), { initialProps: props });
    act(() => result.current.setShowBlueprintModal(false));
    rerender({ ...props, effectiveProjectId: "other" }); // switching projects resets the latch
    expect(result.current.showBlueprintModal).toBe(true);
  });

  it("exposes the clear-confirm flag setter", () => {
    const { result } = renderHook((p: PlanningModalsDeps) => usePlanningModals(p), { initialProps: base });
    act(() => result.current.setShowClearConfirm(true));
    expect(result.current.showClearConfirm).toBe(true);
  });
});
