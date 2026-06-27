import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { usePlanConfirmations } from "./usePlanConfirmations";
import { FEATURES_KEY } from "../stages/planTopics";

type Props = Parameters<typeof usePlanConfirmations>[0];
type Phases = Props["phases"];

const phases = (over: Record<string, unknown> = {}): Phases =>
  ([{ key: "goal", name: "Goal", index: 0, optional: false, status: "active", ...over }] as unknown as Phases);

function baseProps(over: Partial<Props> = {}): Props {
  return {
    phases: phases(),
    focusActiveIdx: 0,
    sections: [],
    planSecs: [],
    confirmedSet: new Set<string>(),
    featureState: { count: 0, allConfirmed: false } as Props["featureState"],
    featureCycle: [],
    effectiveProjectId: "proj",
    paneId: "pane1",
    confirmPlanSection: vi.fn(),
    skipPlanSection: vi.fn(),
    autoCompleteGates: false,
    autoPlanActive: false,
    ...over,
  };
}

describe("usePlanConfirmations", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("confirmStageKeys confirms each key and messages the planner once", () => {
    const props = baseProps();
    const { result } = renderHook(() => usePlanConfirmations(props));
    act(() => { result.current.confirmStageKeys(["goal", "scope"]); });
    expect(props.confirmPlanSection).toHaveBeenCalledWith("proj", "goal");
    expect(props.confirmPlanSection).toHaveBeenCalledWith("proj", "scope");
    expect(invoke).toHaveBeenCalledWith("pty_write", expect.objectContaining({ paneId: "pane1" }));
  });

  it("confirmStageKeys is a no-op for an empty key set", () => {
    const props = baseProps();
    const { result } = renderHook(() => usePlanConfirmations(props));
    act(() => { result.current.confirmStageKeys([]); });
    expect(props.confirmPlanSection).not.toHaveBeenCalled();
  });

  it("onSkipStage skips the active phase and tells the planner", () => {
    const props = baseProps({ phases: phases({ key: "ui", name: "UI", optional: true }) });
    const { result } = renderHook(() => usePlanConfirmations(props));
    act(() => { result.current.onSkipStage(); });
    expect(props.skipPlanSection).toHaveBeenCalledWith("proj", "ui");
    expect(invoke).toHaveBeenCalledWith("pty_write", expect.objectContaining({ paneId: "pane1" }));
  });

  it("pendingConfirm offers the one-click FEATURES confirm once every feature is populated", () => {
    const props = baseProps({
      phases: phases({ key: FEATURES_KEY, name: "Features" }),
      featureState: { count: 2, allConfirmed: true } as Props["featureState"],
    });
    const { result } = renderHook(() => usePlanConfirmations(props));
    expect(result.current.pendingConfirm).toContain(FEATURES_KEY);
  });

  it("pendingConfirm is empty once the active no-gate stage is already confirmed", () => {
    const props = baseProps({ confirmedSet: new Set<string>(["goal"]) });
    const { result } = renderHook(() => usePlanConfirmations(props));
    expect(result.current.pendingConfirm).toEqual([]);
  });

  it("auto-advances the ready set when autoCompleteGates is on (and the autopilot isn't running)", () => {
    vi.useFakeTimers();
    try {
      const props = baseProps({
        phases: phases({ key: FEATURES_KEY, name: "Features" }),
        featureState: { count: 1, allConfirmed: true } as Props["featureState"],
        autoCompleteGates: true,
        autoPlanActive: false,
      });
      renderHook(() => usePlanConfirmations(props));
      act(() => { vi.advanceTimersByTime(900); });
      expect(props.confirmPlanSection).toHaveBeenCalledWith("proj", FEATURES_KEY);
    } finally {
      vi.useRealTimers();
    }
  });
});
