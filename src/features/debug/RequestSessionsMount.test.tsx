import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { RequestSessionsMount } from "./RequestSessionsMount";
import { requestCharter, requestPaneId } from "@/features/debug/requestSession";
import { bscRun } from "@/shared/lib/core/bsc";
import { useAppStore } from "@/store";

// `vi.hoisted` because vi.mock is hoisted ABOVE plain consts: referencing a normal `const` from a mock
// factory throws "Cannot access before initialization" the moment anything calls the mock early (the
// store does, at init). The tests still passed green while that rejection fired — exactly the kind of
// green-but-throwing suite worth not shipping.
const { queue, resetQueue } = vi.hoisted(() => {
  const queue: { rows: { id: number; status: string; claimed_by: string | null }[] } = { rows: [] };
  const resetQueue = () => {
    queue.rows = [
      { id: 1, status: "open", claimed_by: null },
      { id: 2, status: "open", claimed_by: null },
    ];
  };
  resetQueue();
  return { queue, resetQueue };
});

// The queue read, the repo-root probe and the terminal itself are all external systems; stub them so the
// PLAN (which requests get a session) is what the test observes. Mock EVERY export, not just the one
// under test: the store also calls into this module, and a partial mock leaves the rest `undefined`,
// which throws asynchronously while the tests still pass green.
//
// `bscJson` is ARGS-AWARE, and that is load-bearing rather than fussy. The mount now CLAIMS before it
// plans, so a mock that returns the same list for every call would leave every request `open` forever
// and the plan would correctly start nothing — a green suite proving the opposite of the feature. This
// models the real contract: `claim` flips the oldest open row and returns it, atomically.
vi.mock("@/shared/lib/core/bsc", () => ({
  bscJson: vi.fn(async (_cwd: unknown, args: string[]) => {
    if (args[1] === "claim") {
      const next = queue.rows.find((r) => r.status === "open");
      if (!next) return null;
      next.status = "claimed";
      return next;
    }
    return queue.rows;
  }),
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

// #3836: every describe below must start from the SAME state. `#3522` used to reset only
// `autoSpawnDebugSessions`, so when the shuffled order put it after the pool block it inherited that
// block's sessions + seeded prompts and measured something different. One reset, shared by all of them.
const resetAll = () => {
  resetQueue();
  useAppStore.setState({
    autoSpawnDebugSessions: false, paneContinue: {}, paneStartupPromptText: {}, activeDebugSlots: [],
  });
};

describe("RequestSessionsMount — one session per request", () => {
  beforeEach(resetAll);

  it("spawns NOTHING while auto-spawn is off — the default", async () => {
    const { container } = render(<RequestSessionsMount />);
    await new Promise((r) => setTimeout(r, 0));
    expect(useAppStore.getState().paneStartupPromptText).toEqual({});
    expect(container).toBeEmptyDOMElement();
  });

  it("spawns one session per request — BOTH, in the same cycle", async () => {
    // The pool deliberately started one per cycle to pace growth toward a cap. 1:1 has no cap and so
    // nothing to pace against; staggering would only make the queue drain slower. This is the assertion
    // that would have failed under the old model, so it is the one that pins the change.
    useAppStore.setState({ autoSpawnDebugSessions: true });
    render(<RequestSessionsMount />);
    await waitFor(() => {
      expect(Object.keys(useAppStore.getState().paneStartupPromptText).sort())
        .toEqual([requestPaneId(1), requestPaneId(2)].sort());
    });
    // Published as REQUEST IDS now, not anonymous slots — this is what labels the Glance nodes.
    expect([...useAppStore.getState().activeDebugSlots].sort()).toEqual([1, 2]);
  });

  it("CLAIMS each request before binding a session to it", async () => {
    // The claim is what turns `open` into a definite id to bind to, and what stops the standing debug
    // session working the same request. If the mount ever stopped claiming, both would race.
    useAppStore.setState({ autoSpawnDebugSessions: true });
    render(<RequestSessionsMount />);
    await waitFor(() => expect(queue.rows.every((r) => r.status === "claimed")).toBe(true));
  });

  it("launches each session FRESH — never resumes (#3497)", async () => {
    useAppStore.setState({ autoSpawnDebugSessions: true });
    render(<RequestSessionsMount />);
    await waitFor(() => {
      expect(useAppStore.getState().paneContinue[requestPaneId(1)]).toBe(false);
      expect(useAppStore.getState().paneContinue[requestPaneId(2)]).toBe(false);
    });
  });

  it("charters each session with ITS OWN request, not a generic claim", async () => {
    useAppStore.setState({ autoSpawnDebugSessions: true });
    render(<RequestSessionsMount />);
    await waitFor(() => {
      const p = useAppStore.getState().paneStartupPromptText[requestPaneId(2)];
      expect(p).toContain("#2");
      expect(p).toContain("bsc request resolve 2");
      // The pool's generic charter told the session to go and find work. An assigned one is told the
      // opposite — explicitly, because the instruction it must not follow is one it would otherwise
      // infer. Asserted as the PROHIBITION rather than the absence of the string: the charter names
      // `bsc request claim` precisely in order to forbid it.
      expect(p).toContain("do not run `bsc request claim`");
      expect(p).not.toContain("$BSC_AUDIT_PANE"); // the standing session's claim stamp has no place here
    });
  });
});

describe("pruning completed requests when auto-spawn turns on (#3522)", () => {
  const pruneCalls = () =>
    vi.mocked(bscRun).mock.calls.filter(([, args]) => args[0] === "request" && args[1] === "prune");

  beforeEach(() => {
    vi.mocked(bscRun).mockClear();
    resetAll();
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

describe("the per-request charter", () => {
  it("names its request, resolves that id, and never leaves one open", () => {
    const c = requestCharter(78);
    expect(c).toContain("#78");
    expect(c).toContain("bsc request get 78");
    expect(c).toContain("bsc request resolve 78");
    expect(c).toMatch(/never be left open/i);
    // It must NOT claim: the app already did, and a second claim would take someone else's request.
    expect(c).toContain("do not run `bsc request claim`");
    expect(c).not.toContain("$BSC_AUDIT_PANE");
    // And the shared role prose must not smuggle the queue-serving half back in — the whole reason
    // DEBUG_ROLE_PROMPT was split out of DEBUG_START_PROMPT.
    expect(c).not.toMatch(/Start by claiming a request/i);
  });
});
