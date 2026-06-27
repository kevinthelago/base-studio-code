// #1490: usePlanFocusedPane owns the focused-pane SELECTION extracted from Planning.tsx. These tests
// pin the selection behavior the hook owns — auto-follow vs user-pin, out-of-range clamping, and the
// reset-on-switch — plus that the pill derives from the SELECTED phase. The footer/prompt derivations
// are thin pass-throughs to focusedPlan's pure fns (tested there), so they aren't re-asserted here.
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePlanFocusedPane, type PlanFocusedPaneOpts } from "./usePlanFocusedPane";
import type { Phase } from "../stages/focusedPlan";

const phase = (key: string, status: Phase["status"] = "upcoming"): Phase => ({
  key, name: key, glyph: "x", blurb: "", gate: "", index: 0, total: 3, status, fraction: 0,
});

const base: PlanFocusedPaneOpts = {
  phases: [phase("goal", "complete"), phase("scope", "active"), phase("stack")],
  focusActiveIdx: 1,
  planComplete: false,
  focusGateReady: false,
  pendingConfirm: [],
  allowGateOverride: false,
  planSecs: [],
  effectiveProjectId: "proj",
  effectiveBlueprintId: "bp",
};

const render = (p: PlanFocusedPaneOpts = base) =>
  renderHook((props: PlanFocusedPaneOpts) => usePlanFocusedPane(props), { initialProps: p });

describe("usePlanFocusedPane", () => {
  it("auto-follows the active phase when nothing is pinned", () => {
    const { result } = render();
    expect(result.current.focusSelectedIdx).toBe(1); // = focusActiveIdx
    expect(result.current.focusPill).toBe("wait");   // the active phase isn't complete/ahead
  });

  it("pins to a user selection and derives that phase's pill", () => {
    const { result } = render();
    act(() => result.current.setFocusSel(0));
    expect(result.current.focusSelectedIdx).toBe(0);
    expect(result.current.focusPill).toBe("pass");   // phase 0 is complete
  });

  it("clamps an out-of-range selection to the phase list", () => {
    const { result } = render();
    act(() => result.current.setFocusSel(99));
    expect(result.current.focusSelectedIdx).toBe(2); // clamped to the last index
  });

  it("resets the selection on a project switch (re-follows the active phase)", () => {
    const { result, rerender } = render();
    act(() => result.current.setFocusSel(0));
    expect(result.current.focusSelectedIdx).toBe(0);
    rerender({ ...base, effectiveProjectId: "other" });
    expect(result.current.focusSelectedIdx).toBe(1); // selection cleared → back to active
  });

  it("resets the selection on a blueprint switch too", () => {
    const { result, rerender } = render();
    act(() => result.current.setFocusSel(2));
    rerender({ ...base, effectiveBlueprintId: "bp2" });
    expect(result.current.focusSelectedIdx).toBe(1);
  });
});
