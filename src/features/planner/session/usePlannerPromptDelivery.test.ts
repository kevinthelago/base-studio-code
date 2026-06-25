// #1371: the queued route prompt must actually reach the planner — the regression for the
// "design files staged but the planner is never told to route them" bug.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAppStore } from "@/store";
import { usePlannerPromptDelivery } from "./usePlannerPromptDelivery";

describe("usePlannerPromptDelivery", () => {
  beforeEach(() => {
    useAppStore.setState({ pendingPlannerPrompt: {} });
  });

  it("injects a queued prompt into the planner and clears it", () => {
    useAppStore.setState({ pendingPlannerPrompt: { proj: "route these files" } });
    const sendPrompt = vi.fn();

    renderHook(() => usePlannerPromptDelivery("proj", sendPrompt));

    expect(sendPrompt).toHaveBeenCalledExactlyOnceWith("route these files");
    expect(useAppStore.getState().pendingPlannerPrompt.proj).toBeUndefined();
  });

  it("delivers only the active project's prompt, leaving others queued", () => {
    useAppStore.setState({ pendingPlannerPrompt: { proj: "mine", other: "theirs" } });
    const sendPrompt = vi.fn();

    renderHook(() => usePlannerPromptDelivery("proj", sendPrompt));

    expect(sendPrompt).toHaveBeenCalledExactlyOnceWith("mine");
    expect(useAppStore.getState().pendingPlannerPrompt.other).toBe("theirs");
  });

  it("does nothing when nothing is queued", () => {
    const sendPrompt = vi.fn();
    renderHook(() => usePlannerPromptDelivery("proj", sendPrompt));
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("does nothing without a project key", () => {
    useAppStore.setState({ pendingPlannerPrompt: { "": "queued" } });
    const sendPrompt = vi.fn();
    renderHook(() => usePlannerPromptDelivery("", sendPrompt));
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});
