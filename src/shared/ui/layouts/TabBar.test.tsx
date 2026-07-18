import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabBar, type TabItem } from "./TabBar";

const TABS: TabItem[] = [
  { id: "board", label: "Board", hint: "kanban · per column" },
  { id: "coordination", label: "Coordination", hint: "blocked sessions · #199" },
];

describe("TabBar", () => {
  it("renders the main labels", () => {
    render(<TabBar tabs={TABS} activeId="board" onSelect={() => {}} />);
    expect(screen.getByText("Board")).toBeTruthy();
    expect(screen.getByText("Coordination")).toBeTruthy();
  });

  it("exposes the hint as an on-hover title, not inline text (#488)", () => {
    render(<TabBar tabs={TABS} activeId="board" onSelect={() => {}} />);
    // The hint text must NOT render as a visible inline sibling of the label.
    expect(screen.queryByText("kanban · per column")).toBeNull();
    expect(screen.queryByText("blocked sessions · #199")).toBeNull();
    // It's carried on the tab's title attribute instead, alongside the label.
    const tab = screen.getByText("Coordination").closest("[data-tab]");
    expect(tab?.getAttribute("title")).toBe("Coordination — blocked sessions · #199");
  });

  it("falls back to just the label in the title when there is no hint", () => {
    render(<TabBar tabs={[{ id: "x", label: "Plain" }]} activeId="x" onSelect={() => {}} />);
    const tab = screen.getByText("Plain").closest("[data-tab]");
    expect(tab?.getAttribute("title")).toBe("Plain");
  });

  it("selects a tab on click", () => {
    const onSelect = vi.fn();
    render(<TabBar tabs={TABS} activeId="board" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Coordination"));
    expect(onSelect).toHaveBeenCalledWith("coordination");
  });

  it("renders page-level actions in the trailing .tabstrip-actions slot (#3343)", () => {
    render(<TabBar tabs={TABS} activeId="board" onSelect={() => {}} actions={<button>Act</button>} />);
    const action = screen.getByText("Act");
    expect(action.closest(".tabstrip-actions")).toBeTruthy();
  });

  it("renders no actions slot when actions is omitted (#3343)", () => {
    const { container } = render(<TabBar tabs={TABS} activeId="board" onSelect={() => {}} />);
    expect(container.querySelector(".tabstrip-actions")).toBeNull();
  });
});
