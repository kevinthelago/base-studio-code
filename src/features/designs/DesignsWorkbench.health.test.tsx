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
vi.mock("@/features/designs/lib/useComponentScan", () => ({ useComponentScan: vi.fn() }));
// SPY, not a stub: the cache test has to prove the REAL analysis is skipped, so the implementation
// stays and only the call count is observable. A stub would make "it wasn't called" trivially true.
vi.mock("@/features/designs/lib/graphHealth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/designs/lib/graphHealth")>();
  return { ...actual, analyzeGraphHealth: vi.fn(actual.analyzeGraphHealth) };
});

import { DesignsWorkbench } from "@/features/designs/DesignsWorkbench";
import { analyzeGraphHealth } from "@/features/designs/lib/graphHealth";
import { REACT_UI_KIT, REACT_UI_COMPONENTS } from "@/features/designs/lib/reactUiKit";
import { SEED_THEMES } from "@/features/designs/lib/themes";

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
    activeWorkspace: "components",
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

describe("the analysis is not repeated for a library it has already analysed", () => {
  // WHY THIS EXISTS. `analyzeGraphHealth` runs `componentBuildable` over every component in the kit, so
  // it costs ~250ms on a real library and grows with it — measured as the heaviest named phase in the
  // app (`bsc perf phases`: designs:health, 9 runs, 248ms mean, 2.2s total). Nothing was recomputing
  // because the data changed: navigating away and back gave `kitComps`/`libResolver` fresh identities
  // for identical contents, and the whole library was re-analysed to reach the answer just discarded.
  it("re-uses the findings on a remount, and does not run the analyser again", async () => {
    const spy = vi.mocked(analyzeGraphHealth);
    spy.mockClear();

    const first = render(<DesignsWorkbench />);
    await waitFor(() => expect(first.container.querySelector(".ds-health")).toBeTruthy(), { timeout: 3000 });
    const runsAfterFirstVisit = spy.mock.calls.length;
    expect(runsAfterFirstVisit).toBeGreaterThan(0);
    first.unmount();

    // Navigate back. The store's `components` array is untouched, so this is the same library.
    const second = render(<DesignsWorkbench />);
    // Decorated on the FIRST commit — no clear, no idle round trip. This is the user-visible half: the
    // badges are simply there, instead of arriving a beat later after a quarter-second of blocked work.
    expect(second.container.querySelector(".ds-health")).toBeTruthy();
    expect(spy.mock.calls.length).toBe(runsAfterFirstVisit);
  });

  // The cache must not outlive its inputs — stale badges point at components that are no longer there,
  // and the existing behaviour (clear first, then recompute) is what keeps a wrong badge off screen.
  it("re-analyses when the library actually changes", async () => {
    const spy = vi.mocked(analyzeGraphHealth);
    spy.mockClear();

    const first = render(<DesignsWorkbench />);
    await waitFor(() => expect(first.container.querySelector(".ds-health")).toBeTruthy(), { timeout: 3000 });
    const before = spy.mock.calls.length;
    first.unmount();

    // A real edit: a NEW array with different contents, exactly as a store write produces.
    useAppStore.setState({
      components: [...useAppStore.getState().components, { ...orphan, id: "second-orphan", name: "SecondOrphan" }],
    });

    const second = render(<DesignsWorkbench />);
    await waitFor(() => expect(second.container.querySelector(".ds-health")).toBeTruthy(), { timeout: 3000 });
    expect(spy.mock.calls.length).toBeGreaterThan(before);
  });
});
