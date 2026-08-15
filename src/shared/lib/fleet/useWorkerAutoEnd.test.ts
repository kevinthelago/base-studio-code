import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { useWorkerAutoEnd } from "@/shared/lib/fleet/useWorkerAutoEnd";
import type { AgentStream } from "@/features/planner/fleet/planFleet";

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
  // Default invoke: the log reads are the in-process `logs_*` commands (#3630, arrays); the plan issue
  // read stays on the `bsc` bridge (a JSON string). Route by command: `logs_*` → empty log; `bsc` →
  // `plan list … --full` (all issues complete). The done read is event-driven now (#3638) but
  // `useLogStream` still does an initial read on mount, so these fire the same way under `renderHook`.
  vi.mocked(invoke).mockImplementation((cmd: string, _payload?: unknown) => {
    if (cmd === "logs_done_panes") return Promise.resolve([]);     // no self-reported-done panes
    if (cmd === "logs_pane_activity") return Promise.resolve([]);  // no activity rows
    if (cmd === "logs_tail") return Promise.resolve([]);           // coord log empty
    // #3944: real `plan list --full` rows carry `stream` (plan.db's own column — `--stream X` is
    // literally `WHERE stream = :stream`), and the idle sweep now reads once per PROJECT and filters
    // by it in memory instead of querying once per pane. Without the field the filter selects nothing.
    if (cmd === "bsc") return Promise.resolve(JSON.stringify([
      { ref: "#1", status: "complete", stream: "api" },
      { ref: "#2", status: "complete", stream: "api" },
    ]));
    return Promise.resolve(undefined);
  });
  useAppStore.setState({
    endedPanes: {}, paneStatus: {}, paneRoles: { [WORKER]: "worker", [DIRECTOR]: "director" },
    fleetPaneStreams: { [WORKER]: stream("api"), [DIRECTOR]: stream("director") },
    tabs: [{ id: "t", name: "build", layout: "2×1", state: "idle", runId: 0, projectKey: "demo", paneIds: [DIRECTOR, WORKER] }] as never,
  });
});

describe("useWorkerAutoEnd (#920 / #1379)", () => {
  it("#3944: the idle sweep reads each project ONCE, not once per pane", async () => {
    // The sweep used to spawn `bsc plan list --stream <id>` inside the pane loop, serially, on every
    // change to any of THREE log streams — the bulk of 37 `bsc plan list`/min. Two worker panes on one
    // project must now produce ONE project-wide read, not two per-stream reads.
    useAppStore.setState({
      paneRoles: { [WORKER]: "worker", "demo:web": "worker", [DIRECTOR]: "director" },
      fleetPaneStreams: { [WORKER]: stream("api"), "demo:web": stream("web"), [DIRECTOR]: stream("director") },
      tabs: [{ id: "t", name: "build", layout: "2×1", state: "idle", runId: 0, projectKey: "demo", paneIds: [DIRECTOR, WORKER, "demo:web"] }] as never,
    });
    renderHook(() => useWorkerAutoEnd());
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "bsc")).toBe(true));

    const planReads = vi.mocked(invoke).mock.calls.filter(
      (c) => c[0] === "bsc" && (c[1] as { args?: string[] })?.args?.includes("list"),
    );
    // No call may carry --stream: that was the per-pane query this fix removed.
    expect(planReads.every((c) => !(c[1] as { args: string[] }).args.includes("--stream"))).toBe(true);
    // And the project is read at most once per sweep, however many panes it has.
    const perProject = planReads.filter((c) => (c[1] as { projectKey?: string }).projectKey === "demo");
    expect(perProject.length).toBeLessThanOrEqual(1);
  });

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
    expect(invoke).toHaveBeenCalledWith("bsc", { projectKey: "demo", args: ["plan", "list", "--stream", "api", "--full", "--json"] });
  });

  it("flags needs-attention when an owned issue is still open", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string, _payload?: unknown) => {
      if (cmd === "logs_done_panes" || cmd === "logs_pane_activity" || cmd === "logs_tail") return Promise.resolve([]);
      if (cmd === "bsc") return Promise.resolve(JSON.stringify([{ ref: "#1", status: "complete" }, { ref: "#2", status: "in_progress" }]));
      return Promise.resolve(undefined);
    });
    renderHook(() => useWorkerAutoEnd());
    await waitFor(() => expect(handlers[`pty_exit_${WORKER}`]).toBeTypeOf("function"));

    handlers[`pty_exit_${WORKER}`]();

    await waitFor(() => expect(useAppStore.getState().endedPanes[WORKER]?.state).toBe("needs-attention"));
  });

  it("self-closes a worker that reported done via bsc-done — ends it AND kills the PTY (#1379)", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string, _payload?: unknown) => {
      if (cmd === "logs_done_panes") return Promise.resolve([WORKER]);
      if (cmd === "logs_pane_activity" || cmd === "logs_tail") return Promise.resolve([]); // coord/activity empty
      // #3944: real `plan list --full` rows carry `stream` (plan.db's own column — `--stream X` is
    // literally `WHERE stream = :stream`), and the idle sweep now reads once per PROJECT and filters
    // by it in memory instead of querying once per pane. Without the field the filter selects nothing.
    if (cmd === "bsc") return Promise.resolve(JSON.stringify([
      { ref: "#1", status: "complete", stream: "api" },
      { ref: "#2", status: "complete", stream: "api" },
    ]));
      return Promise.resolve(undefined);
    });
    renderHook(() => useWorkerAutoEnd());

    // The done reader (event-driven, but read once on mount) reaps the self-reported worker.
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
    // No plan.db query for this pane — the project-agnostic log reads (`logs_*`) still fire, so narrow
    // the assertion to the `bsc plan list` read the "no DB query" behavior actually means.
    expect(invoke).not.toHaveBeenCalledWith(
      "bsc",
      expect.objectContaining({ args: expect.arrayContaining(["plan", "list"]) }),
    );
  });

  it("REAPS an idle, complete, question-free worker without typing at it (#session-stop-is-honoured)", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string, _payload?: unknown) => {
      // Idle since epoch 1ms ⇒ idleMs is huge, well past the close-nudge window.
      if (cmd === "logs_pane_activity") return Promise.resolve([{ pane: WORKER, state: "idle", at: 1 }]);
      if (cmd === "logs_done_panes" || cmd === "logs_tail") return Promise.resolve([]); // done + coord (no ask/wait) empty
      // #3944: real `plan list --full` rows carry `stream` (plan.db's own column — `--stream X` is
    // literally `WHERE stream = :stream`), and the idle sweep now reads once per PROJECT and filters
    // by it in memory instead of querying once per pane. Without the field the filter selects nothing.
    if (cmd === "bsc") return Promise.resolve(JSON.stringify([
      { ref: "#1", status: "complete", stream: "api" },
      { ref: "#2", status: "complete", stream: "api" },
    ]));
      return Promise.resolve(undefined);
    });
    renderHook(() => useWorkerAutoEnd());

    // The pane reaches its resting state from plan.db — the same verdict source as every other path.
    await waitFor(() => expect(useAppStore.getState().endedPanes[WORKER]).toBeTruthy());
    expect(useAppStore.getState().endedPanes[WORKER]).toMatchObject({ state: "done", streamId: "api" });

    // THE INVARIANT: nothing was typed into the worker. This path used to `pty_write` a "run bsc-done"
    // nudge, which never fired while `bsc-defer` refused a worker's Stop — removing that hook would
    // have switched it on and re-prompted every session the moment it finished.
    const wroteToWorker = vi.mocked(invoke).mock.calls.some(
      ([c, a]) => c === "pty_write" && (a as { paneId: string }).paneId === WORKER,
    );
    expect(wroteToWorker, "a finished worker must not be typed at").toBe(false);
    // And its shell is left alive, so resuming it stays a click the USER makes.
    expect(invoke).not.toHaveBeenCalledWith("pty_kill", { paneId: WORKER });
  });

  it("does NOT type at the director when a worker finishes done (#the-fleet-went-pull-but-nobody-told-the-director-to-pull)", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string, _payload?: unknown) => {
      if (cmd === "logs_done_panes") return Promise.resolve([WORKER]); // worker self-reported done
      if (cmd === "logs_pane_activity" || cmd === "logs_tail") return Promise.resolve([]);
      // #3944: real `plan list --full` rows carry `stream` (plan.db's own column — `--stream X` is
    // literally `WHERE stream = :stream`), and the idle sweep now reads once per PROJECT and filters
    // by it in memory instead of querying once per pane. Without the field the filter selects nothing.
    if (cmd === "bsc") return Promise.resolve(JSON.stringify([
      { ref: "#1", status: "complete", stream: "api" },
      { ref: "#2", status: "complete", stream: "api" },
    ]));
      return Promise.resolve(undefined);
    });
    renderHook(() => useWorkerAutoEnd());

    await waitFor(() => expect(useAppStore.getState().endedPanes[WORKER]?.state).toBe("done"));
    // THIS ASSERTION IS INVERTED FROM WHAT IT WAS. It used to require a close-the-open-issues prompt
    // typed into the director's pane. That write ended with a CR, which submits — opening a Claude
    // turn in a session nobody clicked, through the one path the injector ratchet could not see.
    //
    // It also instructed `gh issue close`, and the GitHub-ownership clause was removed from
    // director-protocol.md under local-first (its own tests assert the absence). So the nudge asked
    // for work the director no longer claims. Nothing replaces it.
    const dirMsg = vi.mocked(invoke).mock.calls.find(([c, a]) => c === "pty_write" && (a as { paneId: string }).paneId === DIRECTOR);
    expect(dirMsg, "the app must not type into the director's session").toBeUndefined();
    // The verdict itself is unchanged — the pane still ends `done`, which the waitFor above pins.
  });

  it("does NOT resurface a lost question INTO the director — the queue carries it instead", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string, _payload?: unknown) => {
      if (cmd === "logs_pane_activity") return Promise.resolve([{ pane: WORKER, state: "idle", at: 1 }]); // idle ages ago
      // An outstanding bsc-ask for the worker, never answered (the coord read is `logs_tail` stream=coord).
      if (cmd === "logs_tail") return Promise.resolve([`2020-01-01T00:00:00Z\t${WORKER}\task\tWhich pagination?\t`]);
      if (cmd === "logs_done_panes") return Promise.resolve([]);
      if (cmd === "bsc") return Promise.resolve(JSON.stringify([{ ref: "#1", status: "in_progress" }]));
      return Promise.resolve(undefined);
    });
    renderHook(() => useWorkerAutoEnd());

    // Let the sweep run — `logs_done_panes` resolving is the signal a tick completed.
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "bsc")).toBe(true));

    // INVERTED, same reason as above: the resurface used to type the worker's question into the
    // director. It does not any more. The information is NOT lost — `bsc logs waiting` lists every
    // unanswered ask oldest-first, and the director's protocol now tells it to sweep that queue on
    // every turn. The pull is strictly better: it shows EVERY stale ask on every sweep, where this
    // fired once per pane per idle period and then went quiet.
    expect(
      vi.mocked(invoke).mock.calls.some(([c, a]) => c === "pty_write" && (a as { paneId: string }).paneId === DIRECTOR),
      "the app must not type into the director's session",
    ).toBe(false);
    expect(useAppStore.getState().endedPanes[WORKER]).toBeUndefined();           // never closes a waiting worker
  });
});
