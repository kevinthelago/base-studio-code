// A Glance drill belongs to ITS TAB (#each-glance-tab-owns-its-own-drill).
//
// THE BUG: `glanceDrill` was a single global value while `activePageTab` — the thing that picks a tab —
// is a map. Nothing re-scoped the drill on a tab change (the only writers are the node click and
// `exitDrill`), so drilling into a layer on one network applied that navigation to every other tab:
// switching landed the user inside a drill belonging to a different domain, on a graph that does not
// contain that node.
//
// Asserted on the STORE rather than through a render, because the leak is a state-shape property: one
// value cannot hold two tabs' depths, and no amount of component behaviour can fix that.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";
import { architectNodeId } from "@/features/glance/lib/glanceGraph";

// Same viewport stub the other GlanceWorkspace tests use — jsdom does no layout measurement.
vi.mock("@/shared/ui/layouts/useGraphViewport", async (orig) => {
  const actual = await orig<typeof import("@/shared/ui/layouts/useGraphViewport")>();
  return {
    ...actual,
    useGraphViewport: () => ({
      view: { tx: 0, ty: 0, scale: 1 },
      setVp: () => {}, onCanvasDown: () => {}, fit: () => {}, centerOn: () => {},
      zoomBy: () => {}, zoomTo: () => {}, zoomToCentered: () => {},
      dragMoved: { current: false }, worldTransform: {},
    }),
  };
});

import { GlanceWorkspace } from "@/features/glance/GlanceWorkspace";

const FINANCE = "network-finance";
const KITCHEN = "network-kitchen";

beforeEach(() => {
  useAppStore.setState({ glanceDrill: {}, activePageTab: {} });
});

describe("each Glance tab keeps its own drill", () => {
  it("does not apply one tab's drill to another", () => {
    useAppStore.getState().setGlanceDrill(FINANCE, "ledger");
    const drills = useAppStore.getState().glanceDrill;
    expect(drills[FINANCE]).toBe("ledger");
    // The whole bug in one assertion: kitchen must still be at its own depth.
    expect(drills[KITCHEN] ?? null).toBeNull();
  });

  it("keeps a tab's drill while another tab drills and exits", () => {
    // Switching away and back must RESTORE the depth, not clear it — the fix is per-tab memory, not a
    // reset on tab change (which would trade a leak for losing the user's place).
    useAppStore.getState().setGlanceDrill(FINANCE, "ledger");
    useAppStore.getState().setGlanceDrill(KITCHEN, "wan-relay");
    useAppStore.getState().setGlanceDrill(KITCHEN, null); // kitchen exits its drill
    const drills = useAppStore.getState().glanceDrill;
    expect(drills[KITCHEN]).toBeNull();
    expect(drills[FINANCE], "finance keeps its own depth").toBe("ledger");
  });

  it("tracks each tab independently across many tabs", () => {
    for (const [tab, target] of [[FINANCE, "a"], [KITCHEN, "b"], ["network-science", "c"]] as const) {
      useAppStore.getState().setGlanceDrill(tab, target);
    }
    expect(useAppStore.getState().glanceDrill).toEqual({
      [FINANCE]: "a", [KITCHEN]: "b", "network-science": "c",
    });
  });
});

describe("the tab a drill belongs to is the tab that shows it", () => {
  it("renders KITCHEN at L0 while FINANCE is drilled", async () => {
    // THE LEAK, as the user meets it: with one global value, a drill set on finance made kitchen render
    // finance's fleet graph — a drill into a project kitchen's tab does not even contain. The proof
    // that kitchen is at L0 is its ARCHITECT node: that node exists only in the project model, and a
    // drill swaps the whole model to the fleet, so drawing it is exactly "not drilled".
    useAppStore.setState({
      networks: [
        { id: KITCHEN, name: "kitchen", position: 0 },
        { id: FINANCE, name: "finance", position: 1 },
      ],
      glanceDrill: { [FINANCE]: "ledger" },   // finance is deep…
      activePageTab: { glance: KITCHEN },     // …and kitchen is what we are showing
      localDraftProjects: {}, triagedProjects: {},
      projectLinks: [], githubToken: "", githubState: null, tabs: [], bscBaseDir: "/base",
    });

    const { container } = render(<GlanceWorkspace />);
    await waitFor(() =>
      expect(
        container.querySelector(`[data-glance-node="${architectNodeId(KITCHEN)}"]`),
        "kitchen must render its own L0, not finance's drill",
      ).toBeTruthy());
  });
});

describe("each tab remembers its own graph position", () => {
  // THE BUG: one `useGraphViewport` instance serves every Glance tab, so a switch applied the outgoing
  // tab's transform to the incoming graph and you landed somewhere arbitrary. Nothing recorded it.
  //
  // Asserted on the STORE, because the leak is a state-shape property — one view cannot hold two tabs'
  // positions. The render path is covered by the sibling case above; what matters here is that leaving
  // a tab records where you were and that another tab cannot overwrite it.
  it("keeps a position per tab", () => {
    useAppStore.setState({ glanceView: {} });
    useAppStore.getState().setGlanceView(FINANCE, { tx: -100, ty: -50, scale: 1.4 });
    useAppStore.getState().setGlanceView(KITCHEN, { tx: 20, ty: 30, scale: 0.6 });
    const v = useAppStore.getState().glanceView;
    expect(v[FINANCE]).toEqual({ tx: -100, ty: -50, scale: 1.4 });
    expect(v[KITCHEN], "kitchen must not inherit finance's transform").toEqual({ tx: 20, ty: 30, scale: 0.6 });
  });

  it("has NO recorded position for a tab never visited — the signal to fit it", () => {
    // `undefined` is load-bearing: it is what tells the workspace to FIT a graph the user has not
    // looked at yet, rather than dropping them at another tab's coordinates.
    useAppStore.setState({ glanceView: {} });
    useAppStore.getState().setGlanceView(FINANCE, { tx: 1, ty: 2, scale: 1 });
    expect(useAppStore.getState().glanceView[KITCHEN]).toBeUndefined();
  });
});
