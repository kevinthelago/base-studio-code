// #components-graph-culls-offscreen-nodes — the workbench mounts only the nodes inside the visible rect.
//
// WHY THE RECT IS INJECTED. jsdom has no layout, so `clientWidth` is 0, so `visibleWorldRect` correctly
// returns null and culling is OFF in every other test in this suite — which is the safe default, and also
// means a render test cannot observe culling by accident. The geometry itself is proven exhaustively in
// `viewportCull.test.ts`; what THIS file proves is the wiring: that the page actually consults the rect,
// tests each node at the coordinates it renders at, and renders everything when there is no rect.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { useAppStore } from "@/store";
import type { GraphBox } from "@/shared/ui/layouts/useGraphViewport";

// esbuild-wasm can't run under jsdom — mock the bundler (mirrors DesignsWorkbench.test.tsx #2824).
vi.mock("@/shared/lib/preview/componentBundle", () => ({
  bundleComponent: vi.fn().mockResolvedValue("/*bundle*/"),
  buildComponentSrcDoc: (js: string) => `<!doctype html><html><body>${js}</body></html>`,
  COMPONENT_IMPORTMAP: { react: "https://esm.sh/react" },
  COMPONENT_EXTERNALS: ["react"],
}));
vi.mock("@/features/designs/lib/uiActivity", () => ({ useUiActivity: vi.fn() }));
vi.mock("./lib/useComponentScan", () => ({ useComponentScan: vi.fn() }));

// The rect the page sees, swappable per test — this is the seam that stands in for real layout.
const { rectRef } = vi.hoisted(() => ({ rectRef: { current: null as GraphBox | null } }));
vi.mock("@/shared/ui/layouts/useVisibleRect", () => ({ useVisibleRect: () => rectRef.current }));

import { DesignsWorkbench } from "./DesignsWorkbench";
import { REACT_UI_KIT, REACT_UI_COMPONENTS } from "./lib/reactUiKit";
import { SEED_THEMES } from "./lib/themes";

const nodeCount = (c: HTMLElement) => c.querySelectorAll(".ds-node").length;

beforeEach(() => {
  rectRef.current = null;
  useAppStore.setState({
    components: REACT_UI_COMPONENTS,
    kits: [REACT_UI_KIT],
    kitThemes: SEED_THEMES,
    aiFocusedId: null,
    designsKitId: "",
    designsCompId: null,
    // The Studio must be the VISIBLE page or the graph never renders (#3627) — same gate every other
    // workbench test sets.
    activeWorkspace: "projects",
    projectsPageMode: "designs",
  });
});

describe("the components graph culls what you cannot see", () => {
  it("renders EVERY node when there is no rect — the unmeasured default is render-everything", () => {
    // The load-bearing default: a viewport that has not been measured must not blank the graph. Every
    // failure mode of the cull is supposed to land here.
    const { container } = render(<DesignsWorkbench />);
    expect(nodeCount(container)).toBe(REACT_UI_COMPONENTS.filter((c) => c.kitId === REACT_UI_KIT.id).length);
  });

  it("drops the nodes outside the rect and keeps the ones inside it", () => {
    const { container } = render(<DesignsWorkbench />);
    const all = nodeCount(container);
    expect(all).toBeGreaterThan(20); // the packaged kit is big enough for this test to mean something

    // A rect around the graph's ORIGIN — the first lane's nodes fall inside, everything below does not.
    rectRef.current = { x: -50, y: -50, w: 400, h: 300 };
    const { container: culled } = render(<DesignsWorkbench />);
    const shown = nodeCount(culled);
    expect(shown).toBeGreaterThan(0);     // …but not so hard that the screen is empty
    expect(shown).toBeLessThan(all);
  });

  it("culls to NOTHING for a rect far off in empty world space", () => {
    // Proves the filter is really running over each node's own coordinates rather than passing
    // everything through — the failure mode a too-clever memo would produce.
    rectRef.current = { x: 900_000, y: 900_000, w: 10, h: 10 };
    const { container } = render(<DesignsWorkbench />);
    expect(nodeCount(container)).toBe(0);
  });

  it("keeps a culled node's identity intact — the ones that survive are unchanged", () => {
    // This slice must be invisible except in the profiler: a surviving node keeps its classes and its
    // data-node hook, so selection, the related ring and the health badges all behave as before.
    rectRef.current = { x: -50, y: -50, w: 400, h: 300 };
    const { container } = render(<DesignsWorkbench />);
    const first = container.querySelector(".ds-node");
    expect(first).toBeTruthy();
    expect(first!.getAttribute("data-node")).not.toBeNull();
  });
});
