import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { useWorkerAutoEnd } from "./useWorkerAutoEnd";
import type { AgentStream } from "@/features/planner/stages/planSections";

const handlers: Record<string, () => void> = {};

const stream = (id: string): AgentStream => ({ id, name: id, repo: "me/app", owns: [], issues: [], dependsOn: [] });

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(handlers)) delete handlers[k];
  vi.mocked(listen).mockImplementation((name, cb) => {
    handlers[name] = () => (cb as (e: { payload: unknown }) => void)({ payload: null });
    return Promise.resolve(() => {});
  });
  // Default invoke: plan_list_issues → all complete; read_coord_log → empty.
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === "plan_list_issues") return Promise.resolve([{ ref: "#1", status: "complete" }, { ref: "#2", status: "complete" }]);
    if (cmd === "read_coord_log") return Promise.resolve([] as string[]);
    return Promise.resolve(undefined);
  });
  useAppStore.setState({
    endedPanes: {}, paneStatus: {}, paneRoles: { t0p0: "worker", t0p1: "director" },
    fleetPaneStreams: { t0p0: stream("api"), t0p1: stream("director") },
    tabs: [{ id: "t", name: "build", layout: "2×1", state: "idle", runId: 0, projectKey: "demo" }] as never,
  });
});

describe("useWorkerAutoEnd (#920)", () => {
  it("subscribes to pty_exit for worker panes only (not the director)", async () => {
    renderHook(() => useWorkerAutoEnd());
    await waitFor(() => expect(handlers["pty_exit_t0p0"]).toBeTypeOf("function"));
    expect(handlers["pty_exit_t0p1"]).toBeUndefined(); // director is not auto-ended
  });

  it("marks a worker done when all owned issues are complete on PTY exit", async () => {
    renderHook(() => useWorkerAutoEnd());
    await waitFor(() => expect(handlers["pty_exit_t0p0"]).toBeTypeOf("function"));

    handlers["pty_exit_t0p0"]();

    await waitFor(() => expect(useAppStore.getState().endedPanes["t0p0"]).toBeTruthy());
    expect(useAppStore.getState().endedPanes["t0p0"]).toMatchObject({ state: "done", streamId: "api" });
    expect(invoke).toHaveBeenCalledWith("plan_list_issues", { projectKey: "demo", stream: "api" });
  });

  it("flags needs-attention when an owned issue is still open", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "plan_list_issues") return Promise.resolve([{ ref: "#1", status: "complete" }, { ref: "#2", status: "in_progress" }]);
      if (cmd === "read_coord_log") return Promise.resolve([] as string[]);
      return Promise.resolve(undefined);
    });
    renderHook(() => useWorkerAutoEnd());
    await waitFor(() => expect(handlers["pty_exit_t0p0"]).toBeTypeOf("function"));

    handlers["pty_exit_t0p0"]();

    await waitFor(() => expect(useAppStore.getState().endedPanes["t0p0"]?.state).toBe("needs-attention"));
  });

  it("does nothing when the project key can't be resolved (no DB query)", async () => {
    useAppStore.setState({ tabs: [{ id: "t", name: "build", layout: "2×1", state: "idle", runId: 0 }] as never });
    renderHook(() => useWorkerAutoEnd());
    await waitFor(() => expect(handlers["pty_exit_t0p0"]).toBeTypeOf("function"));

    handlers["pty_exit_t0p0"]();
    await new Promise((r) => setTimeout(r, 0));

    expect(useAppStore.getState().endedPanes["t0p0"]).toBeUndefined();
    expect(invoke).not.toHaveBeenCalledWith("plan_list_issues", expect.anything());
  });
});
