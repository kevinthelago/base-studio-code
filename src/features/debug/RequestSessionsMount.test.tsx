import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { RequestSessionsMount } from "./RequestSessionsMount";
import { poolCharter, poolPaneId } from "./requestSession";
import { bscRun } from "@/shared/lib/core/bsc";
import { useAppStore } from "@/store";

// `vi.hoisted` because vi.mock is hoisted ABOVE plain consts: referencing a normal `const` from a mock
// factory throws "Cannot access before initialization" the moment anything calls the mock early (the
// store does, at init). The tests still passed green while that rejection fired — exactly the kind of
// green-but-throwing suite worth not shipping.
const { REQUESTS } = vi.hoisted(() => ({
  // The full-list shape `bsc request list --json` returns (status + claimed_by) — two CLAIMABLE requests.
  REQUESTS: [
    { id: 1, status: "open", surface: "bsc ui", cmd: "bsc ui harvest src/shared/ui", text: "the deny list blocks every path" },
    { id: 2, status: "open", surface: "bsc ui", cmd: "bsc ui doctor --fix", text: "doctor wants to delete the pages tier" },
  ],
}));

// The queue read, the repo-root probe and the terminal itself are all external systems; stub them so the
// POOL DECISION (what gets seeded, for which slot) is what the test observes. Mock EVERY export, not just
// the one under test: the store also calls into this module, and a partial mock leaves the rest
// `undefined`, which throws asynchronously while the tests still pass green.
vi.mock("@/shared/lib/core/bsc", () => ({
  bscJson: vi.fn(async () => REQUESTS),
  bsc: vi.fn(async () => ""),
  bscRun: vi.fn(async () => {}),
  bscWrite: vi.fn(async () => {}),
}));
vi.mock("@/shared/lib/core/safeInvoke", () => ({ safeInvoke: vi.fn(async () => "C:/repo") }));
vi.mock("@/app/console/terminal/TerminalSlot", () => ({ TerminalSlot: () => null }));
// Run the poll body once, deterministically, instead of on a timer.
vi.mock("@/shared/hooks/usePoll", () => ({
  usePoll: (fn: () => void | Promise<void>) => { void fn(); },
}));

// Unmount every rendered component between tests. Without it, a prior test's RequestSessionsMount stays
// mounted and subscribed to the store, so a later test that toggles `autoSpawnDebugSessions` also drives
// the stale instances — which was masking a mutation of the prune-on-transition guard in the full run
// (#3522). The gate runs the full file, so this matters.
afterEach(cleanup);

// #3836: every describe below must start from the SAME pool state. `#3522` used to reset only
// `autoSpawnDebugSessions`, so when the shuffled order put it after `#3535` it inherited that
// block's slots + seeded prompts and measured a different pool. One reset, shared by all of them.
const resetPool = () =>
  useAppStore.setState({
    autoSpawnDebugSessions: false, paneContinue: {}, paneStartupPromptText: {}, activeDebugSlots: [],
  });

describe("RequestSessionsMount — the overflow pool (#3535)", () => {
  beforeEach(resetPool);

  it("spawns NOTHING while auto-spawn is off — the default", async () => {
    const { container } = render(<RequestSessionsMount />);
    await new Promise((r) => setTimeout(r, 0));
    expect(useAppStore.getState().paneStartupPromptText).toEqual({});
    expect(container).toBeEmptyDOMElement();
  });

  it("spawns ONE overflow session — paced, not one per request", async () => {
    // Two requests are claimable, but the pool grows one step at a time: only slot 0 this cycle.
    useAppStore.setState({ autoSpawnDebugSessions: true });
    render(<RequestSessionsMount />);
    await waitFor(() => {
      expect(Object.keys(useAppStore.getState().paneStartupPromptText)).toEqual([poolPaneId(0)]);
    });
    expect(useAppStore.getState().activeDebugSlots).toEqual([0]);
  });

  it("launches the overflow session FRESH — never resumes (#3497)", async () => {
    useAppStore.setState({ autoSpawnDebugSessions: true });
    render(<RequestSessionsMount />);
    await waitFor(() => {
      expect(useAppStore.getState().paneContinue[poolPaneId(0)]).toBe(false);
    });
  });

  it("charters the overflow session GENERICALLY — it claims, not a hard-wired request", async () => {
    useAppStore.setState({ autoSpawnDebugSessions: true });
    render(<RequestSessionsMount />);
    await waitFor(() => {
      const p = useAppStore.getState().paneStartupPromptText[poolPaneId(0)];
      expect(p).toContain("bsc request claim");
      // NOT tied to a specific request id or its reported text — that is the point of the pool model.
      expect(p).not.toContain("the deny list blocks every path");
      expect(p).not.toMatch(/REQUEST #\d+ SPECIFICALLY/);
    });
  });
});

describe("pruning completed requests when auto-spawn turns on (#3522)", () => {
  const pruneCalls = () =>
    vi.mocked(bscRun).mock.calls.filter(([, args]) => args[0] === "request" && args[1] === "prune");

  beforeEach(() => {
    vi.mocked(bscRun).mockClear();
    resetPool();
  });

  // FIRST, from a clean slate: mounting with the setting ALREADY on must not prune (see #3522 — this is
  // the only case that distinguishes "prune on transition" from "prune whenever enabled").
  it("does NOT prune on a persisted-on startup — that is not 'turning it on'", async () => {
    useAppStore.setState({ autoSpawnDebugSessions: true });
    render(<RequestSessionsMount />);
    await new Promise((r) => setTimeout(r, 0));
    expect(pruneCalls()).toHaveLength(0);
  });

  it("prunes ONCE on the off→on transition — the user turning the setting on", async () => {
    render(<RequestSessionsMount />);
    expect(pruneCalls()).toHaveLength(0);
    act(() => useAppStore.setState({ autoSpawnDebugSessions: true }));
    await waitFor(() => expect(pruneCalls()).toHaveLength(1));
    expect(pruneCalls()[0]).toEqual([null, ["request", "prune"]]);
  });

  it("does NOT prune when turned OFF, and never re-prunes without a new transition", async () => {
    useAppStore.setState({ autoSpawnDebugSessions: true });
    render(<RequestSessionsMount />);
    await new Promise((r) => setTimeout(r, 0));
    act(() => useAppStore.setState({ autoSpawnDebugSessions: false }));
    await new Promise((r) => setTimeout(r, 0));
    expect(pruneCalls()).toHaveLength(0);
  });
});

describe("the generic overflow charter (#3535)", () => {
  it("claims a request, stamps its own pane, logs via resolve, and never leaves one open", () => {
    const c = poolCharter();
    expect(c).toContain("bsc request claim");
    expect(c).toContain("$BSC_AUDIT_PANE"); // stamps the holder so the pool can tell busy from idle
    expect(c).toContain("bsc request resolve");
    expect(c).toMatch(/never be left open/i);
    // Generic — it names no specific request.
    expect(c).not.toMatch(/REQUEST #\d+/);
  });
});
