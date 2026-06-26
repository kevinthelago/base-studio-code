// #1642: usePlanningSession owns the planner's session-lifecycle operations. These tests pin the
// behaviour-load-bearing bits of the extraction: the clear-plan teardown order, the "keep files"
// regenerate, and the refused-switch guard that must NOT wipe plan files.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MutableRefObject } from "react";
import { renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import { useAppStore } from "@/store";
import { usePlanningSession, type PlanningSessionDeps } from "./usePlanningSession";

const invokeMock = vi.mocked(invoke);

function makeDeps(over: Partial<PlanningSessionDeps> = {}): PlanningSessionDeps {
  return {
    // A null terminal makes handleRestart() a clean no-op, so clear/switch teardown can be
    // asserted in isolation from the PTY re-spawn.
    termRef: { current: null } as MutableRefObject<Terminal | null>,
    bufRef: { current: "" } as MutableRefObject<string>,
    paneId: "planning_proj",
    linkedRepos: [],
    treatAsExisting: false,
    isAuthoring: false,
    activeProjectName: "Proj",
    activeProjectNumber: 7,
    planningPitch: "a pitch",
    effectiveProjectId: "proj",
    stageIdsFor: () => ["goal"],
    refreshSetupSig: vi.fn(),
    setRepoLinkFullNames: vi.fn(),
    setShowBlueprintModal: vi.fn(),
    setShowClearConfirm: vi.fn(),
    setSwitchOpen: vi.fn(),
    ...over,
  };
}

describe("usePlanningSession", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(null);
  });

  it("starts not restarting", () => {
    const { result } = renderHook(() => usePlanningSession(makeDeps()));
    expect(result.current.restarting).toBe(false);
  });

  it("doClearPlan deletes the on-disk plan files, closes the confirm modal, and unlinks repos", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => usePlanningSession(deps));

    await result.current.doClearPlan();

    expect(deps.setShowClearConfirm).toHaveBeenCalledWith(false);
    expect(invokeMock).toHaveBeenCalledWith("clear_project_plan_files", { projectKey: "proj" });
    expect(deps.setRepoLinkFullNames).toHaveBeenCalledWith([]);
  });

  it("keepPlanFiles closes the blueprint modal and regenerates the workspace without wiping plan files", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => usePlanningSession(deps));

    await result.current.keepPlanFiles();

    expect(deps.setShowBlueprintModal).toHaveBeenCalledWith(false);
    expect(invokeMock).toHaveBeenCalledWith("setup_workspaces", expect.objectContaining({ projectKey: "proj" }));
    // "Keep files" must NEVER delete plan files.
    expect(invokeMock).not.toHaveBeenCalledWith("clear_project_plan_files", expect.anything());
  });

  it("doSwitchBlueprint leaves plan files intact when the switch is refused (blueprint unchanged)", async () => {
    // Seed the store so applyBlueprintToProject is a no-op (target == current) → refused.
    useAppStore.setState({ projectBlueprintId: { proj: "bp-x" } });
    const deps = makeDeps();
    const { result } = renderHook(() => usePlanningSession(deps));

    await result.current.doSwitchBlueprint("bp-x");

    expect(deps.setSwitchOpen).toHaveBeenCalledWith(false);
    expect(invokeMock).not.toHaveBeenCalledWith("clear_project_plan_files", expect.anything());
  });
});
