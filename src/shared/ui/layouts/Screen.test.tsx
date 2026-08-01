import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Screen } from "./Screen";
import { useAppStore } from "@/store";
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
    // selector to the store and `useHotkeys` steps them. This is the publish half of that inversion.
    useAppStore.setState({ pageNav: null });
    const onSelect = () => {};
    const { unmount } = render(
      <Screen tabs={PAGES} active="runs" onSelect={onSelect} onReorder={noop} onTearOff={noop}>
        <div>body</div>
      </Screen>,
    );
    expect(useAppStore.getState().pageNav).toMatchObject({ ids: ["library", "runs"], active: "runs" });
    expect(useAppStore.getState().pageNav?.select).toBe(onSelect);

    unmount();
    expect(useAppStore.getState().pageNav).toBeNull();
  });

  it("publishes nothing for a torn-off page — one Page, no bar, nothing to step (#4167)", () => {
    useAppStore.setState({ pageNav: null });
    render(
      <Screen tabs={PAGES} active="runs" onSelect={noop} onReorder={noop} onTearOff={noop} pageOverride="runs">
        <div>body</div>
      </Screen>,
    );
    expect(useAppStore.getState().pageNav).toBeNull();
  });
});

