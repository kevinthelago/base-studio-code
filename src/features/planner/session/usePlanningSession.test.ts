// #1642: usePlanningSession owns the planner's session-lifecycle operations. These tests pin the
// behaviour-load-bearing bits of the extraction: the clear-plan teardown order, the "keep files"
// regenerate, and the refused-switch guard that must NOT wipe plan files.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MutableRefObject } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
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
    setShowBlueprintModal: vi.fn(),
    setShowClearConfirm: vi.fn(),
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

  it("doClearPlan deletes the on-disk plan files and closes the confirm modal", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => usePlanningSession(deps));

    await result.current.doClearPlan();

    expect(deps.setShowClearConfirm).toHaveBeenCalledWith(false);
    expect(invokeMock).toHaveBeenCalledWith("clear_project_plan_files", { projectKey: "proj" });
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

  // #2396: reopening a project used to start a FRESH planner chat — the restart path hardcoded a
  // plain `claude` launch. These pin the resume-by-default launch config (the mount path's trio)
  // and the explicit plain-fresh escape hatch the destructive ops use.
  describe("handleRestart resume config (#2396)", () => {
    // A live-ish terminal so handleRestart runs through to pty_create.
    const term = () =>
      ({ current: { clear: vi.fn(), cols: 80, rows: 24 } as unknown as Terminal }) as MutableRefObject<Terminal | null>;

    const ptyCreateArgs = () => {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === "pty_create");
      expect(call).toBeDefined();
      return call![1] as Record<string, unknown>;
    };

    beforeEach(() => {
      // The default Claude harness; per-command returns so the intro composes and the launch fires.
      useAppStore.setState({ llmProvider: "anthropic", fleetHarness: "claude" });
      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === "planner_intro_prompt") return "hello, I am the planner";
        if (cmd === "setup_workspaces") return { planning_dir: "/hub/proj" };
        return null;
      });
    });

    it("resumes by default: --continue init chain + fresh-only intro + resume request", async () => {
      const { result } = renderHook(() => usePlanningSession(makeDeps({ termRef: term() })));

      await act(() => result.current.handleRestart());

      const args = ptyCreateArgs();
      expect(args.initCmd).toBe("claude --continue 2>/dev/null || claude");
      expect(args.startupPromptFreshOnly).toBe(true);
      expect(args.continueSession).toBe(true);
    });

    it("launches plain-fresh when passed fresh: true (the destructive ops)", async () => {
      const { result } = renderHook(() => usePlanningSession(makeDeps({ termRef: term() })));

      await act(() => result.current.handleRestart({ fresh: true }));

      const args = ptyCreateArgs();
      expect(args.initCmd).toBe("claude");
      expect(args.startupPromptFreshOnly).toBe(false);
      expect(args.continueSession).toBe(false);
    });

    it("doClearPlan restarts through the plain-fresh path", async () => {
      const { result } = renderHook(() => usePlanningSession(makeDeps({ termRef: term() })));

      await act(() => result.current.doClearPlan());

      // handleRestart is fired void from doClearPlan — wait for the relaunch to land.
      await waitFor(() => expect(ptyCreateArgs().initCmd).toBe("claude"));
      expect(ptyCreateArgs().continueSession).toBe(false);
    });
  });
});
