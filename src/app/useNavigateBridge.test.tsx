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
import { registerPreviewFrame, resetPreviewFrames } from "@/features/designs";

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
    useAppStore.setState({ components: [], kits: [] } as never);
  });

  it("hydrates ONCE and re-resolves, so a component written out of band is found", async () => {
    // The designer's exact case: a session writes a component from a shell while the app shows another
    // workspace, so `useUiActivity` (mounted in the Studio, gated on its visibility) never re-hydrated.
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

  it("still errors — after ONE retry — for an id that genuinely does not exist", async () => {
    // The retry must not turn a real miss into a hang or a loop: one hydrate, then the same actionable
    // error it always gave.
    const noop = vi.fn(async () => {});
    useAppStore.setState({
      hydrateComponents: noop,
      kits: [{ id: "harvested", name: "Harvested" }],
      designsKitId: "harvested",
    } as never);

    renderHook(() => useNavigateBridge());
    emitNavigate({ id: "n2", kit: "harvested", component: "does-not-exist" });

    await waitFor(() => expect(sentAck()).toBeTruthy());
    expect(noop).toHaveBeenCalledTimes(1);
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
      activeWorkspace: "projects", projectsPageMode: "designs", designsKitId: "react-d3",
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
