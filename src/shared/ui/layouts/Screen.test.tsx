import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Screen } from "./Screen";
import { getPageNav, setPageNav } from "./pageNav";
import type { TabItem } from "./TabBar";

// The shared Screen shell (#1878): the root tabbed device a Workspace renders through —
// a PageTabs strip (the TabBar) over one active Page body. See docs/frontend-structure.md.
const PAGES: TabItem[] = [
  { id: "library", label: "Library" },
  { id: "runs", label: "Runs" },
];

function noop() {}

describe("Screen shell", () => {
  it("renders the PageTabs strip and the active Page body", () => {
    render(
      <Screen tabs={PAGES} active="library" onSelect={noop} onReorder={noop} onTearOff={noop}>
        <div>library body</div>
      </Screen>,
    );
    // PageTabs renders one tab per page…
    expect(screen.getByText("Library")).toBeTruthy();
    expect(screen.getByText("Runs")).toBeTruthy();
    // …and the active page's body is rendered.
    expect(screen.getByText("library body")).toBeTruthy();
  });

  it("hides the PageTabs strip in torn-off pageOverride mode but still renders the body", () => {
    render(
      <Screen tabs={PAGES} active="runs" onSelect={noop} onReorder={noop} onTearOff={noop} pageOverride="runs">
        <div>runs body</div>
      </Screen>,
    );
    // No tab bar when a single page is torn off into its own window…
    expect(screen.queryByText("Library")).toBeNull();
    expect(screen.queryByText("Runs")).toBeNull();
    // …but the page body is still there.
    expect(screen.getByText("runs body")).toBeTruthy();
  });

  it("publishes its PageTabs for the shell's keyboard owner, and clears on unmount (#4167)", () => {
    // Screen lives in shared/, which may not match a keybinding (#1626/#1703) — so it hands its tabs +
    // selector to a module ref and `useHotkeys` steps them. This is the publish half of that inversion.
    setPageNav(null);
    const onSelect = () => {};
    const { unmount } = render(
      <Screen tabs={PAGES} active="runs" onSelect={onSelect} onReorder={noop} onTearOff={noop}>
        <div>body</div>
      </Screen>,
    );
    expect(getPageNav()).toMatchObject({ ids: ["library", "runs"], active: "runs" });
    expect(getPageNav()?.select).toBe(onSelect);

    unmount();
    expect(getPageNav()).toBeNull();
  });

  it("publishes nothing for a torn-off page — one Page, no bar, nothing to step (#4167)", () => {
    setPageNav(null);
    render(
      <Screen tabs={PAGES} active="runs" onSelect={noop} onReorder={noop} onTearOff={noop} pageOverride="runs">
        <div>body</div>
      </Screen>,
    );
    expect(getPageNav()).toBeNull();
  });

  it("re-publishing on every render cannot loop, even with an UNSTABLE select identity (#4170)", () => {
    // The #4167 regression: publishing to the STORE meant each publish re-rendered the Planner (which
    // subscribes to the whole store), producing a new inline `setActive`, which published again —
    // `Maximum update depth exceeded`. A module ref cannot feed that cycle: no subscribers, no re-render.
    setPageNav(null);
    let renders = 0;
    function Unstable() {
      renders++;
      // A FRESH function identity every render — exactly what a controlled `usePageTabs` page passes.
      return (
        <Screen tabs={PAGES} active="library" onSelect={(id) => void id} onReorder={noop} onTearOff={noop}>
          <div>body</div>
        </Screen>
      );
    }
    render(<Unstable />);
    // A loop would blow the update-depth limit before reaching this assertion.
    expect(renders).toBeLessThan(5);
    expect(getPageNav()?.active).toBe("library");
  });

  it("keeps the tab bar when the page body throws, and clears on navigating away (#4170)", () => {
    // The bar IS the way out of a broken page, so it must never be inside the boundary.
    const Boom = () => { throw new Error("page exploded"); };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <Screen tabs={PAGES} active="library" onSelect={noop} onReorder={noop} onTearOff={noop}>
        <Boom />
      </Screen>,
    );
    // The strip survived — both tabs are still there to click.
    expect(screen.getByText("Library")).toBeTruthy();
    expect(screen.getByText("Runs")).toBeTruthy();
    // …and the failure is stated in place of the body, naming the page and the way out.
    expect(screen.getByRole("alert").textContent).toContain("page exploded");
    expect(screen.getByRole("alert").textContent).toContain("Ctrl");

    // Navigating to another page clears it rather than stranding the workspace behind the fallback.
    rerender(
      <Screen tabs={PAGES} active="runs" onSelect={noop} onReorder={noop} onTearOff={noop}>
        <div>runs body</div>
      </Screen>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("runs body")).toBeTruthy();
    err.mockRestore();
  });
});
