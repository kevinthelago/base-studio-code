// The L0 architect's click OPENS ITS MORPH — asserted by rendering Glance and clicking the node.
//
// WHY THIS IS A RENDER TEST. The morph pipeline gated on the drill in THREE places, and a fix to any
// one of them leaves the click just as dead:
//   1. `expandNode`      — `if (!drill) return;`
//   2. `isLiveAgent`     — `if (!drill) return false;` ahead of the studio branch
//   3. `openChats`       — `if (!drill || …) return [];`, which discards the stored placement
// Source-text assertions caught (1) and would have caught (2) and (3) individually, but nothing that
// reads one site at a time can see a COMPOSITION failure — and the existing
// "clicks through to `expandNode`, not `setDrill`" passed throughout, because a call site existing is
// not the call doing anything. Clicking the real node through the real chain is the only assertion
// that spans all three.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
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

const NETWORK = "network-finance";
const ARCHITECT = architectNodeId(NETWORK);

describe("a network architect opens from L0 (#the-architect-morph-is-drilled-only)", () => {
  beforeEach(() => {
    useAppStore.setState({
      networks: [{ id: NETWORK, name: "finance", position: 0 }],
      // L0 — NOT drilled. This is the whole point: the architect node only ever exists here.
      glanceDrill: null,
      activePageTab: { glance: NETWORK },
      localDraftProjects: {}, triagedProjects: {},
      projectLinks: [], githubToken: "", githubState: null, tabs: [], bscBaseDir: "/base",
    });
  });

  it("draws the architect node on its network's tab", async () => {
    const { container } = render(<GlanceWorkspace />);
    await waitFor(() =>
      expect(container.querySelector(`[data-glance-node="${ARCHITECT}"]`)).toBeTruthy());
  });

  it("opens its morph when clicked, with no drill", async () => {
    // The failure this pins: every gate above returns silently, so the node stays a node and the user
    // sees nothing at all — no error, no selection, no terminal.
    const { container } = render(<GlanceWorkspace />);
    const node = await waitFor(() => {
      const el = container.querySelector(`[data-glance-node="${ARCHITECT}"]`);
      expect(el).toBeTruthy();
      return el as Element;
    });

    fireEvent.click(node);

    await waitFor(
      () => expect(container.querySelector(".glance-card")).toBeTruthy(),
      { timeout: 2000 },
    );
  });
});
