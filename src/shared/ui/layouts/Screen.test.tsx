import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Screen } from "./Screen";
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

  it("renders headerActions in the page-header strip (#3343)", () => {
    render(
      <Screen tabs={PAGES} active="library" onSelect={noop} onReorder={noop} onTearOff={noop}
        headerActions={<button>▶ Start project</button>}>
        <div>library body</div>
      </Screen>,
    );
    // The page-level action rides the header's `.tabstrip-actions` slot, alongside the tabs.
    const action = screen.getByText("▶ Start project");
    expect(action).toBeTruthy();
    expect(action.closest(".tabstrip-actions")).toBeTruthy();
  });

  it("drops headerActions with the tab bar in torn-off pageOverride mode (#3343)", () => {
    render(
      <Screen tabs={PAGES} active="runs" onSelect={noop} onReorder={noop} onTearOff={noop} pageOverride="runs"
        headerActions={<button>▶ Start project</button>}>
        <div>runs body</div>
      </Screen>,
    );
    // No header strip when torn off ⇒ no header actions either; the body still renders.
    expect(screen.queryByText("▶ Start project")).toBeNull();
    expect(screen.getByText("runs body")).toBeTruthy();
  });
});
