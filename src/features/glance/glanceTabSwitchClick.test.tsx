// After a TAB SWITCH the graph is still usable — nodes draw, and a click still opens.
//
// TWO failures met as one symptom ("I can't interact with nodes after switching tabs", and "sometimes
// the node doesn't load in"), both fallout from making every Glance tab its own graph:
//
//  1. A STALE GRID ANCHOR SWALLOWED THE CLICK. `gridAnchorId` is released only when the last morph
//     closes, or by `exitDrill` — never on a tab change. So it named a node of the tab being LEFT, and
//     `openChat` did `if (!anchor) return prev;`, dropping the placement with no error and no
//     selection. `openChats`, the READ side, already tolerated a stale anchor via `resolveGridAnchor`;
//     the WRITER did not.
//
//  2. A RECORDED VIEW PINNED THE GRAPH OFF-SCREEN. `restoreView` sets `userMoved`, which disables
//     `useGraphViewport`'s world-change re-fit — and that re-fit is the only thing that re-frames a
//     graph whose data arrives async (#3433: "the real data then arrives, the world grows, and nothing
//     re-frames it — the graph renders from screen center off the bottom-right"). A view captured
//     before a tab's data landed was therefore pinned forever.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent, act } from "@testing-library/react";
import { useAppStore } from "@/store";
import { architectNodeId } from "@/features/glance/lib/glanceGraph";

const KITCHEN = "network-kitchen";
const FINANCE = "network-finance";

// The viewport stub the other GlanceWorkspace tests use, plus the two seams under test. `moved` is
// what the real hook's `userMoved` ref is: false until the USER pans/zooms.
let moved = false;
const restored: unknown[] = [];
vi.mock("@/shared/ui/layouts/useGraphViewport", async (orig) => {
  const actual = await orig<typeof import("@/shared/ui/layouts/useGraphViewport")>();
  return {
    ...actual,
    useGraphViewport: () => ({
      view: { tx: 0, ty: 0, scale: 1 },
      setVp: () => {}, onCanvasDown: () => {}, fit: () => {}, centerOn: () => {},
      restoreView: (v: unknown) => { restored.push(v); },
      hasUserMoved: () => moved,
      zoomBy: () => {}, zoomTo: () => {}, zoomToCentered: () => {},
      dragMoved: { current: false }, worldTransform: {},
    }),
  };
});

import { GlanceWorkspace } from "@/features/glance/GlanceWorkspace";

const seed = (activeTab: string) => ({
  networks: [
    { id: KITCHEN, name: "kitchen", position: 0 },
    { id: FINANCE, name: "finance", position: 1 },
  ],
  glanceDrill: {}, glanceView: {},
  activePageTab: { glance: activeTab },
  localDraftProjects: {}, triagedProjects: {},
  projectLinks: [], githubToken: "", githubState: null, tabs: [], bscBaseDir: "/base",
});

const nodeIn = async (container: HTMLElement, id: string) =>
  await waitFor(() => {
    const el = container.querySelector(`[data-glance-node="${id}"]`);
    expect(el, `${id} must be on the graph`).toBeTruthy();
    return el as Element;
  });

const switchTo = (tab: string) =>
  act(() => { useAppStore.getState().setActivePageTab("glance", tab); });

describe("the graph stays usable across a tab switch", () => {
  beforeEach(() => {
    moved = false;
    restored.length = 0;
    useAppStore.setState(seed(KITCHEN));
  });

  it("still opens a node on the tab you switched TO, after opening one on the tab you left", async () => {
    const { container, rerender } = render(<GlanceWorkspace />);

    // Opening this is what sets `gridAnchorId` — the state that used to go stale.
    fireEvent.click(await nodeIn(container, architectNodeId(KITCHEN)));
    await waitFor(() => expect(container.querySelector(".glance-card")).toBeTruthy());

    switchTo(FINANCE);
    rerender(<GlanceWorkspace />);

    fireEvent.click(await nodeIn(container, architectNodeId(FINANCE)));
    await waitFor(
      () => expect(container.querySelector(".glance-card"), "the click must open a morph").toBeTruthy(),
      { timeout: 2000 },
    );
  });

  it("records NO position for a tab the user never positioned", async () => {
    // The one that pinned a graph off-screen. A fitted view is reproducible on return, so recording it
    // buys nothing — and restoring it would suppress the async-data re-fit for good.
    const { rerender } = render(<GlanceWorkspace />);
    switchTo(FINANCE);
    rerender(<GlanceWorkspace />);
    await waitFor(() => expect(useAppStore.getState().activePageTab.glance).toBe(FINANCE));
    expect(useAppStore.getState().glanceView[KITCHEN], "a merely fitted view is not a position").toBeUndefined();
  });

  it("records the position of a tab the user DID move, and restores it on return", async () => {
    const { rerender } = render(<GlanceWorkspace />);
    moved = true;                       // the user panned/zoomed kitchen
    switchTo(FINANCE);
    rerender(<GlanceWorkspace />);
    await waitFor(() => expect(useAppStore.getState().glanceView[KITCHEN]).toBeTruthy());

    switchTo(KITCHEN);
    rerender(<GlanceWorkspace />);
    await waitFor(() => expect(restored.length, "returning restores the recorded position").toBeGreaterThan(0));
  });
});
