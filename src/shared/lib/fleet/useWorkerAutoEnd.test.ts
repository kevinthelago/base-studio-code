import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { useWorkerAutoEnd } from "./useWorkerAutoEnd";
import type { AgentStream } from "@/features/planner/stages/planSections";

// Fleet workers carry STABLE pane ids (#1176): `<projectKey>:<streamId>`, not positional `t{n}p{n}`.
// The project key is resolved from the owning tab's `paneIds` (#1379 regression fix) — these ids +
// the tab's `paneIds` mirror what fleetStartProject actually mints.
const WORKER = "demo:api";
const DIRECTOR = "demo:director";

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
    endedPanes: {}, paneStatus: {}, paneRoles: { [WORKER]: "worker", [DIRECTOR]: "director" },
    fleetPaneStreams: { [WORKER]: stream("api"), [DIRECTOR]: stream("director") },
    tabs: [{ id: "t", name: "build", layout: "2×1", state: "idle", runId: 0, projectKey: "demo", paneIds: [DIRECTOR, WORKER] }] as never,
  });
});

describe("useWorkerAutoEnd (#920 / #1379)", () => {
  it("subscribes to pty_exit for worker panes only (not the director)", async () => {
    renderHook(() => useWorkerAutoEnd());
    await waitFor(() => expect(handlers[`pty_exit_${WORKER}`]).toBeTypeOf("function"));
    expect(handlers[`pty_exit_${DIRECTOR}`]).toBeUndefined(); // director is not auto-ended
  });

  it("marks a worker done when all owned issues are complete on PTY exit", async () => {
    renderHook(() => useWorkerAutoEnd());
    await waitFor(() => expect(handlers[`pty_exit_${WORKER}`]).toBeTypeOf("function"));

    handlers[`pty_exit_${WORKER}`]();

    await waitFor(() => expect(useAppStore.getState().endedPanes[WORKER]).toBeTruthy());
    expect(useAppStore.getState().endedPanes[WORKER]).toMatchObject({ state: "done", streamId: "api" });
    // The project key resolves from the tab's paneIds (the #1176/#1379 regression guard) — not a positional id.
    expect(invoke).toHaveBeenCalledWith("plan_list_issues", { projectKey: "demo", stream: "api" });
  });

  it("flags needs-attention when an owned issue is still open", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "plan_list_issues") return Promise.resolve([{ ref: "#1", status: "complete" }, { ref: "#2", status: "in_progress" }]);
      if (cmd === "read_coord_log") return Promise.resolve([] as string[]);
      return Promise.resolve(undefined);
    });
    renderHook(() => useWorkerAutoEnd());
    await waitFor(() => expect(handlers[`pty_exit_${WORKER}`]).toBeTypeOf("function"));

    handlers[`pty_exit_${WORKER}`]();

    await waitFor(() => expect(useAppStore.getState().endedPanes[WORKER]?.state).toBe("needs-attention"));
  });

  it("self-closes a worker that reported done via bsc-done — ends it AND kills the PTY (#1379)", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "read_done_panes") return Promise.resolve([WORKER]);
      if (cmd === "plan_list_issues") return Promise.resolve([{ ref: "#1", status: "complete" }, { ref: "#2", status: "complete" }]);
      if (cmd === "read_coord_log") return Promise.resolve([] as string[]);
      return Promise.resolve(undefined);
    });
    renderHook(() => useWorkerAutoEnd());

    // The done poller reaps the self-reported worker on its first tick.
    await waitFor(() => expect(useAppStore.getState().endedPanes[WORKER]).toBeTruthy());
    expect(useAppStore.getState().endedPanes[WORKER]).toMatchObject({ state: "done", streamId: "api" });
    expect(invoke).toHaveBeenCalledWith("pty_kill", { paneId: WORKER }); // the live shell is actually killed
  });

  it("does nothing when the project key can't be resolved (no paneIds → no DB query)", async () => {
    // A tab with no paneIds can't map the pane to a project — evaluateExit must bail (no #1176 fallback).
    useAppStore.setState({ tabs: [{ id: "t", name: "build", layout: "2×1", state: "idle", runId: 0 }] as never });
    renderHook(() => useWorkerAutoEnd());
    await waitFor(() => expect(handlers[`pty_exit_${WORKER}`]).toBeTypeOf("function"));

    handlers[`pty_exit_${WORKER}`]();
    await new Promise((r) => setTimeout(r, 0));

    expect(useAppStore.getState().endedPanes[WORKER]).toBeUndefined();
    expect(invoke).not.toHaveBeenCalledWith("plan_list_issues", expect.anything());
  });

  it("nudges an idle, complete, question-free worker to self-close (#1379 stage 3)", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      // Idle since epoch 1ms ⇒ idleMs is huge, well past the close-nudge window.
      if (cmd === "read_pane_activity") return Promise.resolve([{ pane: WORKER, state: "idle", at: 1 }]);
      if (cmd === "read_coord_log") return Promise.resolve([] as string[]);   // no outstanding ask / wait
      if (cmd === "plan_list_issues") return Promise.resolve([{ ref: "#1", status: "complete" }, { ref: "#2", status: "complete" }]);
      return Promise.resolve(undefined); // read_done_panes ⇒ undefined ⇒ the done poller no-ops
    });
    renderHook(() => useWorkerAutoEnd());

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("pty_write", expect.objectContaining({ paneId: WORKER })));
    const nudge = vi.mocked(invoke).mock.calls.find(([c, a]) => c === "pty_write" && (a as { paneId: string }).paneId === WORKER);
    expect((nudge?.[1] as { data: string }).data).toContain("bsc-done"); // told to self-close
    // It only NUDGES — it never ends the pane itself (the worker does, via bsc-done).
    expect(useAppStore.getState().endedPanes[WORKER]).toBeUndefined();
  });

  it("nudges the director to close still-open issues when a worker finishes done (#1379 stage 3)", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "read_done_panes") return Promise.resolve([WORKER]); // worker self-reported done
      if (cmd === "plan_list_issues") return Promise.resolve([{ ref: "#1", status: "complete" }, { ref: "#2", status: "complete" }]);
      if (cmd === "read_coord_log") return Promise.resolve([] as string[]);
      return Promise.resolve(undefined);
    });
    renderHook(() => useWorkerAutoEnd());

    await waitFor(() => expect(useAppStore.getState().endedPanes[WORKER]?.state).toBe("done"));
    // The live director pane gets a close-the-open-issues prompt.
    const dirMsg = vi.mocked(invoke).mock.calls.find(([c, a]) => c === "pty_write" && (a as { paneId: string }).paneId === DIRECTOR);
    expect(dirMsg, "director should be nudged to close issues").toBeTruthy();
    expect((dirMsg?.[1] as { data: string }).data).toContain("gh issue close");
  });

  it("resurfaces a lost director question to the director after the long wait (#1379 stage 4)", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "read_pane_activity") return Promise.resolve([{ pane: WORKER, state: "idle", at: 1 }]); // idle ages ago
      // An outstanding bsc-ask for the worker, never answered.
      if (cmd === "read_coord_log") return Promise.resolve([`2020-01-01T00:00:00Z\t${WORKER}\task\tWhich pagination?\t`]);
      if (cmd === "plan_list_issues") return Promise.resolve([{ ref: "#1", status: "in_progress" }]);
      return Promise.resolve(undefined);
    });
    renderHook(() => useWorkerAutoEnd());

    await waitFor(() => expect(
      vi.mocked(invoke).mock.calls.some(([c, a]) => c === "pty_write" && (a as { paneId: string }).paneId === DIRECTOR),
    ).toBe(true));
    const m = vi.mocked(invoke).mock.calls.find(([c, a]) => c === "pty_write" && (a as { paneId: string }).paneId === DIRECTOR);
    expect((m?.[1] as { data: string }).data).toContain(`bsc-answer ${WORKER}`); // routes the answer back to the worker
    expect(useAppStore.getState().endedPanes[WORKER]).toBeUndefined();           // never closes a waiting worker
  });
});
