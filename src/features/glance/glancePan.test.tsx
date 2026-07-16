// Regression (#2554): the Glance viewport must NOT re-fit on a data poll — only when a node is
// opened/closed (the drill target changes). The old effect keyed on `model`, which gets a fresh
// reference on every liveness/fault/stall recompute, so it wiped the user's pan every few seconds.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";

// Spy on the shared viewport's `fit`; stub the rest of the hook's surface so the workspace renders.
const { fitSpy } = vi.hoisted(() => ({ fitSpy: vi.fn() }));
vi.mock("@/shared/ui/layouts/useGraphViewport", async (orig) => {
  const actual = await orig<typeof import("@/shared/ui/layouts/useGraphViewport")>();
  return {
    ...actual,
    useGraphViewport: () => ({
      view: { tx: 0, ty: 0, scale: 1 },
      setVp: () => {}, onCanvasDown: () => {}, fit: fitSpy, centerOn: () => {},
      zoomBy: () => {}, zoomTo: () => {}, zoomToCentered: () => {}, panBy: () => {},
      dragMoved: { current: false }, worldTransform: {},
    }),
  };
});

import { GlanceWorkspace } from "./GlanceWorkspace";

/** Flush one requestAnimationFrame tick (the fit is deferred via rAF). */
const flushRaf = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });

describe("Glance viewport re-fit (#2554)", () => {
  beforeEach(() => {
    fitSpy.mockClear();
    // One triaged project so the Network graph renders a node (not the empty state).
    useAppStore.setState({
      localDraftProjects: { proj: { title: "Proj", pitch: "", createdAt: 1 } },
      triagedProjects: { proj: 1 },
      projectLinks: [], glanceDrill: null, githubToken: "", githubState: null,
    });
  });

  it("fits on mount, NOT on a data recompute, but again when a node is opened (drill)", async () => {
    render(<GlanceWorkspace />);
    await waitFor(() => expect(fitSpy).toHaveBeenCalled()); // initial fit lands (rAF-deferred)
    const afterMount = fitSpy.mock.calls.length;

    // A data-only change recomputes the graph model (new reference) but must NOT re-fit — this is the
    // regression: the old `[model]` dep re-fit here every poll, resetting the pan.
    await act(async () => { useAppStore.setState({ projectLinks: [{ id: "l", from: "proj", to: "ghost", kind: "api" }] }); });
    await flushRaf();
    expect(fitSpy.mock.calls.length).toBe(afterMount); // unchanged — no refit on data change

    // Opening a node (drill) DOES re-center the newly-swapped graph.
    await act(async () => { useAppStore.setState({ glanceDrill: "proj" }); });
    await waitFor(() => expect(fitSpy.mock.calls.length).toBe(afterMount + 1));
  });
});
