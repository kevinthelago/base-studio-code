// #navigate-answers-from-a-stale-app-snapshot — the ADAPTER half of the #55 fix.
//
// `navigateBridge.test.ts` covers the pure decision, including which misses are marked retryable. What
// only the adapter can be tested for is the part that actually fixes the designer's report: that a
// retryable miss triggers ONE re-read of the store and re-resolves against it, and that the internal
// marker never reaches Rust.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";
import { useNavigateBridge } from "@/app/useNavigateBridge";
import * as tauriEvent from "@tauri-apps/api/event";
import * as tauriCore from "@tauri-apps/api/core";
import { registerPreviewFrame, resetPreviewFrames, readLibraryIndex } from "@/features/designs";

// Everything real EXCEPT the cheap library read, which the retry now goes through. Spreading the
// original keeps `registerPreviewFrame`/`mountedPreviewFrames` as the SAME module state the bridge
// reads — a separate copy would make every mount assertion below silently vacuous.
vi.mock("@/features/designs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/designs")>()),
  readLibraryIndex: vi.fn(),
}));

/** Point the cheap read at a library, or at nothing (`null` = the read itself failed). */
function libraryIs(components: unknown[], kits: unknown[] = [{ id: "harvested", name: "Harvested" }]): void {
  vi.mocked(readLibraryIndex).mockResolvedValue({ components, kits } as never);
}

/** Fire the `bsc://navigate` payload the bridge listens for, by invoking the handler it registered. */
function emitNavigate(payload: Record<string, unknown>): void {
  const call = vi.mocked(tauriEvent.listen).mock.calls.find(([name]) => name === "bsc://navigate");
  const handler = call?.[1] as ((e: { payload: unknown }) => void) | undefined;
  if (!handler) throw new Error("the bridge never subscribed to bsc://navigate");
  handler({ payload });
}

/** The ack the bridge sent to Rust, or undefined if it hasn't yet. */
function sentAck(): Record<string, unknown> | undefined {
  const call = vi.mocked(tauriCore.invoke).mock.calls.find(([cmd]) => cmd === "navigate_ack");
  return (call?.[1] as { ack?: Record<string, unknown> } | undefined)?.ack;
}

describe("useNavigateBridge re-reads the store on a resolvable miss (#55)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    libraryIs([]);
    useAppStore.setState({ components: [], kits: [] } as never);
  });

  it("hydrates ONCE and re-resolves, so a component written out of band is found", async () => {
    // The designer's exact case: a session writes a component from a shell while the app shows another
    // workspace, so `useUiActivity` (mounted in the Studio, gated on its visibility) never re-hydrated.
    // The CHEAP index is what sees it first; the full hydrate then converges the store so the Studio can
    // actually render what was selected.
    libraryIs([{ id: "kitthemecard", name: "KitThemeCard", kitId: "harvested" }]);
    const arrive = vi.fn(async () => {
      useAppStore.setState({
        kits: [{ id: "harvested", name: "Harvested" }],
        components: [{ id: "kitthemecard", name: "KitThemeCard", kitId: "harvested" }],
        designsKitId: "harvested",
      } as never);
    });
    useAppStore.setState({ hydrateComponents: arrive } as never);

    renderHook(() => useNavigateBridge());
    emitNavigate({ id: "n1", kit: "harvested", component: "kitthemecard" });

    await waitFor(() => expect(sentAck()).toBeTruthy());
    expect(arrive, "the miss must trigger exactly one re-read").toHaveBeenCalledTimes(1);
    expect(sentAck()?.error, "after re-reading, the component resolves").toBeUndefined();
  });

  it("still errors for an id that genuinely does not exist — and pays NO full hydrate for it", async () => {
    // The retry must not turn a real miss into a hang or a loop. And the expensive read is no longer
    // spent to learn something the 80 KB index already settled: that is the whole fix for #104, where
    // this path blocked the main thread for 5s+ and the caller got a message about the window.
    const noop = vi.fn(async () => {});
    useAppStore.setState({
      hydrateComponents: noop,
      kits: [{ id: "harvested", name: "Harvested" }],
      designsKitId: "harvested",
    } as never);

    renderHook(() => useNavigateBridge());
    emitNavigate({ id: "n2", kit: "harvested", component: "does-not-exist" });

    await waitFor(() => expect(sentAck()).toBeTruthy());
    expect(readLibraryIndex, "the cheap read answers it").toHaveBeenCalledTimes(1);
    expect(noop, "and the 5.9 MB one is never reached").not.toHaveBeenCalled();
    expect(String(sentAck()?.error)).toContain("unknown component 'does-not-exist'");
  });

  it("falls back to the original error when the cheap read itself is unreachable", async () => {
    // `readLibraryIndex` answers `null` when either read fails. That is not evidence the record exists,
    // so the honest move is the error we already had — not a hydrate fired on no evidence at all.
    vi.mocked(readLibraryIndex).mockResolvedValue(null);
    const hydrate = vi.fn(async () => {});
    useAppStore.setState({
      hydrateComponents: hydrate, kits: [{ id: "harvested", name: "Harvested" }], designsKitId: "harvested",
    } as never);

    renderHook(() => useNavigateBridge());
    emitNavigate({ id: "n2b", kit: "harvested", component: "does-not-exist" });

    await waitFor(() => expect(sentAck()).toBeTruthy());
    expect(hydrate).not.toHaveBeenCalled();
    expect(String(sentAck()?.error)).toContain("unknown component 'does-not-exist'");
  });

  it("never ships the internal retry marker to Rust", async () => {
    // `retryAfterHydrate` is the adapter's own signal; the Rust `NavAck` never declared it.
    useAppStore.setState({ hydrateComponents: vi.fn(async () => {}) } as never);
    renderHook(() => useNavigateBridge());
    emitNavigate({ id: "n3", kit: "nope" });

    await waitFor(() => expect(sentAck()).toBeTruthy());
    expect(sentAck()).not.toHaveProperty("retryAfterHydrate");
    expect(sentAck()?.id).toBe("n3");
  });

  it("does not re-read when the request resolved fine", async () => {
    // No steady-state cost: the hydrate is paid only on a miss, never on the happy path.
    const hydrate = vi.fn(async () => {});
    useAppStore.setState({ hydrateComponents: hydrate } as never);
    renderHook(() => useNavigateBridge());
    emitNavigate({ id: "n4" });

    await waitFor(() => expect(sentAck()).toBeTruthy());
    expect(hydrate).not.toHaveBeenCalled();
  });
});

// REGRESSION, designer request #104. The retry was an unbounded `await`, and a full `hydrateComponents`
// does not fit in the Rust waiter's 5s: the designs store measures the `--full` read at up to 8040ms. So
// an unresolvable id blew the budget DETERMINISTICALLY and the caller was told the frontend "did not apply
// the navigation — is a window open?" — a sentence about the window that says nothing about the id.
//
// Measured against the running app before the fix: the error paths that do NOT retry answered in 0.12s
// and 0.17s; both paths that DO took 5.17s and 5.01s and timed out. The ack was never lost. It arrived
// after nobody was waiting, which is indistinguishable from never for everyone downstream.
// REGRESSION, and it is the second attempt at #104. The first bounded the retry with
// `Promise.race([hydrateComponents(), setTimeout(2000)])`. THAT DOES NOT WORK AND CANNOT:
// `hydrateComponents` blocks the main thread, so the timer cannot fire until the thing it bounds has
// already finished. Measured on the merged build — a miss still took 5.13s, and a `bsc navigate show`
// fired 1.0s into it took 8.0s and timed out, because the app answered nothing at all for the duration.
//
// Its unit tests passed because they used a never-settling promise, which leaves the event loop FREE —
// they proved the timer works under the one condition where the bug does not occur. So these tests pin
// the WORK NOT DONE (no full hydrate on a miss) rather than a wall-clock number, because elapsed time in
// jsdom says nothing about a blocked renderer.
describe("useNavigateBridge answers a miss from the CHEAP read, not the 5.9 MB one", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPreviewFrames();
    libraryIs([]);
    useAppStore.setState({
      components: [], kits: [{ id: "harvested", name: "Harvested" }], designsKitId: "harvested",
    } as never);
  });

  it("acks a miss even when the full hydrate would never finish", async () => {
    // The pathological shape, and the one the old bound claimed to handle: a hydrate that outlives the
    // request entirely. It is now simply not on this path.
    const never = vi.fn(() => new Promise<void>(() => {}));
    useAppStore.setState({ hydrateComponents: never } as never);
    renderHook(() => useNavigateBridge());
    emitNavigate({ id: "b1", kit: "harvested", component: "does-not-exist" });

    await waitFor(() => expect(sentAck()).toBeTruthy());
    expect(String(sentAck()?.error)).toContain("unknown component 'does-not-exist'");
    expect(never, "nothing waited on it, so it cannot strand the ack").not.toHaveBeenCalled();
  });

  it("an unknown KIT is answered the same way — it is the other retryable miss", async () => {
    const never = vi.fn(() => new Promise<void>(() => {}));
    useAppStore.setState({ hydrateComponents: never } as never);
    renderHook(() => useNavigateBridge());
    emitNavigate({ id: "b2", kit: "no-such-kit" });

    await waitFor(() => expect(sentAck()).toBeTruthy());
    expect(String(sentAck()?.error)).toContain("unknown kit 'no-such-kit'");
    expect(never).not.toHaveBeenCalled();
  });

  it("pays the full hydrate ONLY when the cheap read says it will change the answer", async () => {
    // The evidence for spending 5.9 MB is now the cheap read, not the bare fact of a miss. This is the
    // #55 case: the record is really there and this window's copy is behind.
    libraryIs([{ id: "kitthemecard", name: "KitThemeCard", kitId: "harvested" }]);
    const hydrate = vi.fn(async () => {
      useAppStore.setState({
        components: [{ id: "kitthemecard", name: "KitThemeCard", kitId: "harvested" }],
      } as never);
    });
    useAppStore.setState({ hydrateComponents: hydrate } as never);
    renderHook(() => useNavigateBridge());
    emitNavigate({ id: "b3", kit: "harvested", component: "kitthemecard" });

    await waitFor(() => expect(sentAck()).toBeTruthy());
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(sentAck()?.error).toBeUndefined();
  });

  it("acks from the STORE after that hydrate, never from the projection", async () => {
    // The projection carries no `srcText`. Acking the value resolved against it would promise a preview
    // that cannot build yet — so if the hydrate does not actually converge, this must say so rather than
    // report the success the cheap read saw.
    libraryIs([{ id: "kitthemecard", name: "KitThemeCard", kitId: "harvested" }]);
    useAppStore.setState({ hydrateComponents: vi.fn(async () => {}) } as never); // converges nothing
    renderHook(() => useNavigateBridge());
    emitNavigate({ id: "b4", kit: "harvested", component: "kitthemecard" });

    await waitFor(() => expect(sentAck()).toBeTruthy());
    expect(String(sentAck()?.error)).toContain("unknown component 'kitthemecard'");
  });
});

// The `if (disposed) return` early-outs were the only paths out of the handler that produced no ack at
// all — the plan item's prime suspect for the timeout, and the one thing here that is unanswerable by
// construction rather than merely slow. Measurement cleared it as the cause of #104 (the hydrate budget
// was), but a silent return is still a stranded waiter, so it is closed either way.
describe("useNavigateBridge acks on EVERY path out, teardown included", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPreviewFrames();
  });

  // THE LIMIT, stated because the first version of this test asserted past it: "acks on every path OUT"
  // is about every RETURN, not about every hang. A promise that never settles is not a path out — the
  // `await` simply never comes back, so there is no code that could ack. What is guaranteed is that once
  // an await DOES settle, a torn-down bridge answers instead of returning into silence. Bounding the
  // reads themselves would be a different change, and on the hydrate it is one that provably cannot work.
  it("acks the teardown when the bridge unmounts while the cheap read is in flight", async () => {
    vi.mocked(readLibraryIndex).mockReturnValue(
      new Promise((r) => setTimeout(() => r({ components: [], kits: [] }), 50)) as never,
    );
    useAppStore.setState({
      components: [], kits: [{ id: "harvested", name: "Harvested" }], designsKitId: "harvested",
      hydrateComponents: vi.fn(async () => {}),
    } as never);
    const { unmount } = renderHook(() => useNavigateBridge());
    emitNavigate({ id: "d1", kit: "harvested", component: "does-not-exist" });
    unmount();

    await waitFor(() => expect(sentAck()).toBeTruthy(), { timeout: 4_000 });
    expect(String(sentAck()?.error)).toContain("torn down mid-navigation");
    expect(String(sentAck()?.error)).toContain("bsc navigate show");
    expect(sentAck()?.id).toBe("d1");
  }, 10_000);

  it("acks the teardown when the bridge unmounts mid-hydrate", async () => {
    // The third checkpoint: the cheap read HIT, so the expensive convergence is under way when the
    // window goes. Each `await` in the handler is a place the bridge can vanish, and each must answer
    // once it settles (see the limit stated above).
    libraryIs([{ id: "kitthemecard", name: "KitThemeCard", kitId: "harvested" }]);
    useAppStore.setState({
      components: [], kits: [{ id: "harvested", name: "Harvested" }], designsKitId: "harvested",
      hydrateComponents: vi.fn(() => new Promise<void>((r) => setTimeout(r, 50))),
    } as never);
    const { unmount } = renderHook(() => useNavigateBridge());
    emitNavigate({ id: "d1b", kit: "harvested", component: "kitthemecard" });
    unmount();

    await waitFor(() => expect(sentAck()).toBeTruthy(), { timeout: 4_000 });
    expect(String(sentAck()?.error)).toContain("torn down mid-navigation");
    expect(sentAck()?.id).toBe("d1b");
  }, 10_000);

  it("acks the teardown when the bridge unmounts while waiting for the frame to settle", async () => {
    // The second silent return: a resolvable navigate whose preview never settles, unmounted mid-wait.
    useAppStore.setState({
      activeWorkspace: "components", designsKitId: "react-d3",
      kits: [{ id: "react-d3", name: "D3" }],
      components: [{ id: "Heatmap", name: "Heatmap", kitId: "react-d3" }],
      hydrateComponents: vi.fn(async () => {}),
    } as never);
    const { unmount } = renderHook(() => useNavigateBridge());
    emitNavigate({ id: "d2", kit: "react-d3", component: "Heatmap" });
    unmount();

    await waitFor(() => expect(sentAck()).toBeTruthy(), { timeout: 4_000 });
    expect(String(sentAck()?.error)).toContain("torn down mid-navigation");
  }, 10_000);
});

// The ack reported the store SELECTION — the value it had just written — so a component the preview
// REFUSED to build acked exactly like one that rendered. Since the caller's next move is `bsc shot
// preview`, that produced a capture of the previously-mounted component with nothing reporting it.
// Observed directly: `navigate plan-body-deployment` acked success while the frame still showed
// `ui-tab-bar`. The adapter is the only half that can be tested for this — the pure bridge decides only
// that a mount is owed.
describe("useNavigateBridge reports what the preview actually MOUNTED", () => {
  /** On the Studio, with one component the bridge can resolve. */
  const onStudio = () =>
    useAppStore.setState({
      // The Design Studio is its own WORKSPACE now (`five-graphs-become-rail-workspaces`) — being on
      // it is the whole condition, with no Planner page mode to also match.
      activeWorkspace: "components", designsKitId: "react-d3",
      kits: [{ id: "react-d3", name: "D3" }],
      components: [{ id: "Heatmap", name: "Heatmap", kitId: "react-d3" }],
      hydrateComponents: vi.fn(async () => {}),
    } as never);

  // CONNECTED on purpose: `mountedPreviewFrames` drops entries whose iframe has left the document, so a
  // detached element registers and is then invisible to the reader — the frame would read as "never
  // settled" for reasons that have nothing to do with the code under test.
  const iframe = () => document.body.appendChild(document.createElement("iframe"));

  beforeEach(() => {
    vi.clearAllMocks();
    resetPreviewFrames();
    onStudio();
  });

  it("reports `mounted` once the frame settles on the requested component", async () => {
    registerPreviewFrame("f1", { component: "Heatmap", iframe: iframe(), status: "ready", engineRequested: false, engineInSrcdoc: false });
    renderHook(() => useNavigateBridge());
    emitNavigate({ id: "m1", kit: "react-d3", component: "Heatmap" });

    await waitFor(() => expect(sentAck()).toBeTruthy());
    expect(sentAck()?.mounted).toBe("Heatmap");
    expect(sentAck()?.mountError).toBeUndefined();
  });

  it("REPRODUCER: a component the preview refused to build acks the refusal, not a mount", async () => {
    registerPreviewFrame("f1", {
      component: "Heatmap", iframe: iframe(), status: "error",
      error: '"Heatmap" has no implementation source yet', engineRequested: false, engineInSrcdoc: false,
    });
    renderHook(() => useNavigateBridge());
    emitNavigate({ id: "m2", kit: "react-d3", component: "Heatmap" });

    await waitFor(() => expect(sentAck()).toBeTruthy());
    expect(sentAck()?.mounted, "nothing is on screen, so nothing is claimed").toBeUndefined();
    expect(String(sentAck()?.mountError)).toContain("refused to build 'Heatmap'");
    expect(String(sentAck()?.mountError)).toContain("no implementation source yet");
    // The SELECTION still lands and is still reported — the navigate did its half.
    expect(sentAck()?.component).toBe("Heatmap");
  });

  it("says 'did not settle' rather than success when no frame ever settles", async () => {
    renderHook(() => useNavigateBridge()); // no frame registered at all
    emitNavigate({ id: "m3", kit: "react-d3", component: "Heatmap" });

    await waitFor(() => expect(sentAck()).toBeTruthy(), { timeout: 4_000 });
    expect(sentAck()?.mounted).toBeUndefined();
    expect(String(sentAck()?.mountError)).toContain("had not settled");
    expect(String(sentAck()?.mountError)).toContain("do not capture yet");
  }, 10_000);

  it("never ships the internal awaitMount marker to Rust", async () => {
    registerPreviewFrame("f1", { component: "Heatmap", iframe: iframe(), status: "ready", engineRequested: false, engineInSrcdoc: false });
    renderHook(() => useNavigateBridge());
    emitNavigate({ id: "m4", kit: "react-d3", component: "Heatmap" });

    await waitFor(() => expect(sentAck()).toBeTruthy());
    expect(sentAck()).not.toHaveProperty("awaitMount");
  });

  it("does not wait at all when the navigate DECLINED — nothing is going to rebuild", async () => {
    useAppStore.setState({ activeWorkspace: "github", projectsPageMode: "projects" } as never);
    renderHook(() => useNavigateBridge());
    const started = Date.now();
    emitNavigate({ id: "m5", kit: "react-d3", component: "Heatmap" });

    await waitFor(() => expect(sentAck()).toBeTruthy());
    // The whole point of the decline path: it acks immediately instead of burning the caller's budget
    // waiting for a frame that will never rebuild.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(sentAck()?.mounted).toBeUndefined();
    expect(sentAck()?.mountError).toBeUndefined();
    expect(String(sentAck()?.declined)).toContain("view unchanged");
  });
});
