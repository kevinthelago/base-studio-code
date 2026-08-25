import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { RequestSessionsMount } from "@/features/debug/RequestSessionsMount";
import { requestCharter, requestPaneId, originLabel } from "@/features/debug/requestSession";
import { bscRun } from "@/shared/lib/core/bsc";
import { fireInvoke, safeInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import { designerSessionId, librarianSessionId, SOUND_STUDIO_SESSION_ID } from "@/shared/lib/session/systemSessions";

// `vi.hoisted` because vi.mock is hoisted ABOVE plain consts: referencing a normal `const` from a mock
// factory throws "Cannot access before initialization" the moment anything calls the mock early (the
// store does, at init). The tests still passed green while that rejection fired — exactly the kind of
// green-but-throwing suite worth not shipping.
const { queue, resetQueue, ptys, invokeImpl } = vi.hoisted(() => {
  const queue: {
    rows: { id: number; status: string; claimed_by: string | null; origin: string | null; display_title: string }[];
  } = { rows: [] };
  // The app's PTY session map, as `pty_pane_runtime` reports it. The mount must reconcile against THIS
  // rather than against anything it remembers — a session outlives the component that started it, which
  // is the whole of `a-resolved-requests-debug-session-is-never-closed`.
  const ptys: { live: Set<string> } = { live: new Set() };
  const resetQueue = () => {
    queue.rows = [
      { id: 1, status: "open", claimed_by: null, origin: "design-studio:designer-react", display_title: "ui list needs --kit" },
      { id: 2, status: "open", claimed_by: null, origin: "algorithms-studio:librarian-typescript", display_title: "impl list needs --domain" },
    ];
    ptys.live = new Set();
  };
  resetQueue();
  // Hoisted WITH the state it reads. Declared as a plain const it would be referenced by the hoisted
  // `vi.mock` factory before initialization — the same trap this file's header already documents.
  const invokeImpl = async (cmd: string, payload?: unknown) => {
    if (cmd === "reload_sidecars") return [];
    if (cmd === "pty_pane_runtime") {
      const ids = (payload as { paneIds?: string[] } | undefined)?.paneIds ?? [];
      return ids.map((paneId) => ({ paneId, live: ptys.live.has(paneId) }));
    }
    return "C:/repo";
  };
  return { queue, resetQueue, ptys, invokeImpl };
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
// `safeInvoke` serves THREE calls here — the repo-root probe, the liveness read and the sidecar reload —
// so the mock dispatches on the command name. A single blanket return would answer the reload with a path
// and the repo-root probe with whatever the reload wanted, which is how a mock starts lying quietly.
// (`pty_pane_runtime` is the one that would break loudest: a bare string has no `.filter`.)
vi.mock("@/shared/lib/core/safeInvoke", () => ({
  safeInvoke: vi.fn(invokeImpl),
  // The kill is fire-and-forget, so it is a DIFFERENT export — mocking only `safeInvoke` would leave
  // `fireInvoke` undefined and the mount would throw asynchronously while the suite stayed green.
  fireInvoke: vi.fn((cmd: string, payload?: { paneId?: string }) => {
    if (cmd === "pty_kill" && payload?.paneId) ptys.live.delete(payload.paneId);
  }),
}));
// The slot stands in for the real one, and the real one CREATES THE PTY. Registering the pane here is
// what makes `pty_pane_runtime` above answer truthfully on the next poll — without it every session
// would read as dead one tick after it started, and the mount would re-charter it forever.
vi.mock("@/app/console/terminal/TerminalSlot", () => ({
  TerminalSlot: ({ paneId }: { paneId: string }) => {
    ptys.live.add(paneId);
    return null;
  },
}));
// Run the poll body once, deterministically, instead of on a timer.
vi.mock("@/shared/hooks/usePoll", () => ({
  usePoll: (fn: () => void | Promise<void>) => { void fn(); },
}));

// Unmount every rendered component between tests. Without it, a prior test's RequestSessionsMount stays
// mounted and subscribed to the store, so a later test also drives the stale instances — which was
// masking a mutation of the prune guard in the full run (#3522). The gate runs the full file.
afterEach(cleanup);

// #3836: every describe below must start from the SAME state — otherwise a shuffled order lets one
// block inherit another's sessions + seeded prompts and measure something different.
const resetAll = () => {
  resetQueue();
  // RE-INSTALL the default safeInvoke behaviour. One test overrides it to simulate a machine with no
  // source tree, and `mockImplementation` persists for the whole FILE — so without this reset every
  // later test silently ran against a null repo root and asserted nothing spawning, which is a green
  // suite proving the opposite of the feature.
  vi.mocked(safeInvoke).mockImplementation(invokeImpl as never);
  vi.mocked(fireInvoke).mockClear();
  useAppStore.setState({ paneContinue: {}, paneStartupPromptText: {}, activeDebugRequests: [] });
};

describe("RequestSessionsMount — one session per request", () => {
  beforeEach(resetAll);

  // #debug-nodes-hang-off-the-session-that-filed-them: there is NO toggle any more. The test that used
  // to live here asserted the off-by-default behaviour, which WAS the bug — the whole 1:1 machinery
  // shipped switched off, so a filed request waited for someone to notice. What replaces it is the one
  // gate that is not a preference: a machine with no source tree cannot run these at all.
  it("spawns nothing when there is no source tree — a shipped binary, not a preference", async () => {
    vi.mocked(safeInvoke).mockImplementation(async (cmd: string) => (cmd === "reload_sidecars" ? [] : null));
    const { container } = render(<RequestSessionsMount />);
    await new Promise((r) => setTimeout(r, 0));
    expect(useAppStore.getState().paneStartupPromptText).toEqual({});
    expect(container).toBeEmptyDOMElement();
  });

  it("spawns one session per request — BOTH, in the same cycle", async () => {
    // The pool deliberately started one per cycle to pace growth toward a cap. 1:1 has no cap and so
    // nothing to pace against; staggering would only make the queue drain slower. This is the assertion
    // that would have failed under the old model, so it is the one that pins the change.
    render(<RequestSessionsMount />);
    // BOTH assertions inside ONE waitFor, because they are published by DIFFERENT effects and settle at
    // different times (#requestsessionsmount-is-order-dependent). The poll body writes
    // `paneStartupPromptText`; a separate `useEffect` keyed on `[sessions, setActiveDebugRequests]`
    // publishes `activeDebugRequests`. Awaiting only the prompts and then asserting the requests BARE
    // leaves a real window — prompts landed, effect not yet flushed — and under load that window widens
    // until the assertion sees `[]`.
    //
    // It read as an order dependency for a long time: green alone (11/11), green in the dom project
    // (438 files), green in the full suite (733), and red once in a 103-file `--changed` subset. What
    // settles it is that the EXACT failing command passes twice on the same tree — same input, two
    // outputs, which is non-determinism rather than a polluting neighbour. There was never a state leak
    // to isolate; a `waitFor` that covers everything it should have covered is the whole fix.
    await waitFor(() => {
      expect(Object.keys(useAppStore.getState().paneStartupPromptText).sort())
        .toEqual([requestPaneId(1), requestPaneId(2)].sort());
      // Published with PROVENANCE, not as bare ids: the Glance node is labelled `debug - <title>` and
      // edged to the session that filed the request, and neither is derivable from an id.
      expect([...useAppStore.getState().activeDebugRequests].sort((a, b) => a.id - b.id)).toEqual([
        { id: 1, origin: "design-studio:designer-react", title: "ui list needs --kit" },
        { id: 2, origin: "algorithms-studio:librarian-typescript", title: "impl list needs --domain" },
      ]);
    });
  });

  it("CLAIMS each request before binding a session to it", async () => {
    // The claim is what turns `open` into a definite id to bind to. It stays atomic even though the
    // standing session it used to race is gone: two app instances on one machine share this queue.
    render(<RequestSessionsMount />);
    await waitFor(() => expect(queue.rows.every((r) => r.status === "claimed")).toBe(true));
  });

  it("launches each session FRESH — never resumes (#3497)", async () => {
    render(<RequestSessionsMount />);
    await waitFor(() => {
      expect(useAppStore.getState().paneContinue[requestPaneId(1)]).toBe(false);
      expect(useAppStore.getState().paneContinue[requestPaneId(2)]).toBe(false);
    });
  });

  it("charters each session with ITS OWN request, not a generic claim", async () => {
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

describe("a resolved request goes live without a restart", () => {
  beforeEach(() => {
    vi.mocked(safeInvoke).mockClear();
    resetAll();
  });

  const reloadCalls = () => vi.mocked(safeInvoke).mock.calls.filter(([cmd]) => cmd === "reload_sidecars");

  it("re-stages the sidecar when a session closes because its request resolved", async () => {
    // The point of the whole loop: the debug session rebuilt `bsc`, so the new binary has to be staged
    // and the warm child retired before the NEXT call, or the fix sits on disk unused until a restart.
    const { rerender } = render(<RequestSessionsMount />);
    await waitFor(() => expect(Object.keys(useAppStore.getState().paneStartupPromptText)).toHaveLength(2));

    // The session works its request and resolves it. Next reconcile ⇒ its session closes ⇒ reload.
    queue.rows = queue.rows.map((r) => (r.id === 1 ? { ...r, status: "resolved" } : r));
    vi.mocked(safeInvoke).mockClear();
    rerender(<RequestSessionsMount />);
    await waitFor(() => expect(reloadCalls().length).toBeGreaterThan(0));
  });

  it("does NOT reload while nothing has closed — a steady queue must not restage on every poll", async () => {
    // Staging is a file copy that parks a locked binary as `.old-<stamp>`. Doing it on every 20s tick
    // would churn the sidecar dir for no reason and, worse, retire a perfectly good warm child each time.
    render(<RequestSessionsMount />);
    await waitFor(() => expect(Object.keys(useAppStore.getState().paneStartupPromptText)).toHaveLength(2));
    expect(reloadCalls()).toHaveLength(0);
  });
});

// REGRESSION, `a-resolved-requests-debug-session-is-never-closed`. A session OUTLIVES the component that
// started it — the PTY is owned by the backend, and `TerminalView`'s cleanup deliberately keeps it alive
// so a console tab-switch reconnects rather than respawns. The mount was reconciling against a
// `useState([])` it accumulated as it started sessions, and that state dies on every remount: after a
// workspace change or an app restart it was `[]`, so `close` was `[]`, and every running session was
// orphaned with its `claude` process live for good.
//
// The old suite could not see it because its close test uses `rerender`, which keeps the SAME instance and
// its ref. A rerender is not a remount. These mount FRESH against PTYs that are already up, which is the
// only shape that reproduces it.
describe("a session outlives the component that started it", () => {
  beforeEach(resetAll);

  const killed = () =>
    vi.mocked(fireInvoke).mock.calls
      .filter(([cmd]) => cmd === "pty_kill")
      .map(([, payload]) => (payload as { paneId?: string } | undefined)?.paneId);

  it("closes a resolved request's session though THIS mount never started it", async () => {
    queue.rows = [
      { id: 1, status: "resolved", claimed_by: null, origin: null, display_title: "done" },
      { id: 2, status: "claimed", claimed_by: null, origin: null, display_title: "in flight" },
    ];
    ptys.live = new Set([requestPaneId(1), requestPaneId(2)]);

    render(<RequestSessionsMount />);
    await waitFor(() => expect(killed()).toContain(requestPaneId(1)));
    // …and the one still working its request is left strictly alone. A reconcile that closed both would
    // be just as wrong, and far louder.
    expect(killed()).not.toContain(requestPaneId(2));
  });

  it("does not re-charter a claimed request whose session is already running", async () => {
    // The same empty-set bug in the other direction: `start` is "claimed with no TRACKED session", so a
    // fresh mount also re-chartered every live one. Harmless only because `pty_create` reconnects.
    queue.rows = [{ id: 2, status: "claimed", claimed_by: null, origin: null, display_title: "in flight" }];
    ptys.live = new Set([requestPaneId(2)]);

    render(<RequestSessionsMount />);
    await new Promise((r) => setTimeout(r, 0));
    expect(useAppStore.getState().paneStartupPromptText).toEqual({});
  });

  it("still starts a claimed request whose session is genuinely gone", async () => {
    // The reconcile has to work both ways, or "derive it" would just be a different way to be wrong:
    // a session the user stopped by hand must come back.
    queue.rows = [{ id: 2, status: "claimed", claimed_by: null, origin: null, display_title: "in flight" }];
    ptys.live = new Set();

    render(<RequestSessionsMount />);
    await waitFor(() =>
      expect(Object.keys(useAppStore.getState().paneStartupPromptText)).toEqual([requestPaneId(2)]));
  });
});

describe("pruning completed requests (#3522)", () => {
  const pruneCalls = () =>
    vi.mocked(bscRun).mock.calls.filter(([, args]) => args[0] === "request" && args[1] === "prune");

  beforeEach(() => {
    vi.mocked(bscRun).mockClear();
    resetAll();
  });

  // The trigger MOVED with the toggle (#debug-nodes-hang-off-the-session-that-filed-them). It used to
  // fire on the off→on transition — the only moment a user could express "start working the queue".
  // With no toggle, mount is that moment, and it is still exactly ONCE: a resolved row left in the
  // store would otherwise linger as a node for a request nobody is working.
  it("prunes ONCE on mount", async () => {
    render(<RequestSessionsMount />);
    await waitFor(() => expect(pruneCalls()).toHaveLength(1));
    expect(pruneCalls()[0]).toEqual([null, ["request", "prune"]]);
  });

  it("does not re-prune on a re-render — staging churn is the thing this avoids", async () => {
    const { rerender } = render(<RequestSessionsMount />);
    await waitFor(() => expect(pruneCalls()).toHaveLength(1));
    rerender(<RequestSessionsMount />);
    await new Promise((r) => setTimeout(r, 0));
    expect(pruneCalls()).toHaveLength(1);
  });
});

describe("the per-request charter", () => {
  it("names its request, resolves that id, and never leaves one open", () => {
    const c = requestCharter({ id: 78 });
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

  // ── #debug-request-carries-its-origin ─────────────────────────────────────────────────────────
  //
  // The session that files a request and the session that fixes it are different sessions, and the fix
  // is only right if it unblocks the FILER's real workflow. Putting the origin only on the graph edge
  // would leave the one actor who has to act on it — the debug session — unable to see it.

  it("names the session that filed the request, and how to reply to it", () => {
    const c = requestCharter({ id: 85, origin: "design-studio:designer-react", display_title: "ui list needs --kit" });
    expect(c).toContain('"ui list needs --kit"');
    expect(c).toContain("the react designer");
    expect(c).toContain("`design-studio:designer-react`");
    // The reply channel matters as much as the attribution: a debug session that finds the request
    // ambiguous must have somewhere to say so that the filer actually reads back.
    expect(c).toContain('bsc request note 85');
  });

  it("says nothing about an origin when the request has none", () => {
    const c = requestCharter({ id: 90, origin: null, display_title: null });
    expect(c).toContain("#90");
    expect(c).not.toMatch(/filed by/i);
    // No dangling attribution phrasing, and no empty quotes where the title would be.
    expect(c).not.toContain('""');
  });

  it("labels a per-technology studio by its technology, and falls back to the raw id", () => {
    // Two designers exist (react / react-native); the charter has to say WHICH, since the same gap
    // reported from either is a different reproduction.
    expect(originLabel(designerSessionId("react"))).toBe("the react designer");
    expect(originLabel(designerSessionId("react-native"))).toBe("the react-native designer");
    expect(originLabel(librarianSessionId("typescript"))).toBe("the typescript librarian");
    expect(originLabel(SOUND_STUDIO_SESSION_ID)).toBe("the sound designer");
    // A director-filed request (the one non-studio filer) has no studio phrasing — better the raw
    // pane id than an invented role.
    expect(originLabel("myproject:director")).toBe("myproject:director");
  });
});
