// #graph-health-stops-blocking-first-paint — the badges still arrive.
//
// Deferring graph health off the render path has one failure mode that no other test in this suite would
// notice: the findings never land, and the graph simply renders forever without badges. Nothing guarded
// the badge path before this file, so the deferral could have silently turned a feature off and every
// existing test would still have passed.
//
// So this asserts the SEQUENCE the change introduces — painted first, decorated after — rather than just
// the end state, because "the badge is there" alone would also pass if the work were still blocking paint.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";

vi.mock("@/shared/lib/preview/componentBundle", () => ({
  bundleComponent: vi.fn().mockResolvedValue("/*bundle*/"),
  buildComponentSrcDoc: (js: string) => `<!doctype html><html><body>${js}</body></html>`,
  COMPONENT_IMPORTMAP: { react: "https://esm.sh/react" },
  COMPONENT_EXTERNALS: ["react"],
}));
vi.mock("@/features/designs/lib/uiActivity", () => ({ useUiActivity: vi.fn() }));
vi.mock("./lib/useComponentScan", () => ({ useComponentScan: vi.fn() }));

import { DesignsWorkbench } from "@/features/designs/DesignsWorkbench";
import { REACT_UI_KIT, REACT_UI_COMPONENTS } from "@/features/designs/lib/reactUiKit";
import { SEED_THEMES } from "./lib/themes";

/** An ORPHAN: a component nothing composes and which composes nothing — a finding the analyzer reports,
 *  so the graph must eventually badge it. */
const orphan = {
  ...REACT_UI_COMPONENTS[0],
  id: "lonely-orphan", name: "LonelyOrphan", composes: [], used: 0,
};

beforeEach(() => {
  useAppStore.setState({
    components: [...REACT_UI_COMPONENTS, orphan],
    kits: [REACT_UI_KIT],
    kitThemes: SEED_THEMES,
    aiFocusedId: null,
    designsKitId: "",
    designsCompId: null,
    activeWorkspace: "projects",
    projectsPageMode: "designs",
  });
});

describe("graph health arrives after paint, not before it", () => {
  it("paints the graph FIRST with no badges, then badges once idle work runs", async () => {
    const { container } = render(<DesignsWorkbench />);

    // The graph is already on screen…
    expect(container.querySelectorAll(".ds-node").length).toBeGreaterThan(0);
    // …and undecorated, because the analysis has not run yet. This is the half that proves the work is
    // genuinely OFF the render path: if it still blocked paint, badges would already be here.
    expect(container.querySelector(".ds-health")).toBeFalsy();

    // jsdom has no requestIdleCallback, so `runWhenIdle` falls back to a timeout — the fallback that
    // makes the deferral safe where the API is missing. If it were a no-op, this would never resolve.
    await waitFor(() => expect(container.querySelector(".ds-health")).toBeTruthy(), { timeout: 3000 });
  });

  it("shows the toolbar finding count once the analysis lands", async () => {
    const { container } = render(<DesignsWorkbench />);
    await waitFor(() => {
      const chip = [...container.querySelectorAll("*")].find((el) => /^⚠ \d+$/.test(el.textContent ?? ""));
      expect(chip).toBeTruthy();
    }, { timeout: 3000 });
  });
});
