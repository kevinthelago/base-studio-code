import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectRow } from "../../screens/planner/ProjectsList";

const mockProject = {
  id: "PVT_1",
  number: 7,
  title: "My App",
  shortDescription: "desc",
  url: "https://github.com/x",
  closed: false,
  updatedAt: new Date().toISOString(),
  items: { totalCount: 3, nodes: [
    { content: { state: "OPEN" } },
    { content: { state: "CLOSED" } },
    { content: { state: "CLOSED" } },
  ] },
  repositories: { nodes: [{ nameWithOwner: "o/a" }] },
};

function row(over: Partial<Parameters<typeof ProjectRow>[0]> = {}) {
  return (
    <ProjectRow
      p={mockProject}
      running={0}
      paused={0}
      onPlan={() => {}}
      onBoard={() => {}}
      onDelete={() => {}}
      menuOpenId={mockProject.id}
      setMenuOpenId={() => {}}
      {...over}
    />
  );
}

// Regression guard: the row's ⋯ menu items must reach their handlers. The bug
// was an eager document-mousedown handler that closed the menu before the item's
// click fired, so delete/board never ran.
describe("ProjectRow", () => {
  it("clicking the row opens planning (#499)", () => {
    const onPlan = vi.fn();
    render(row({ onPlan }));
    fireEvent.click(screen.getByText("open planning →"));
    expect(onPlan).toHaveBeenCalledWith(mockProject);
  });

  it("shows the live fleet pill when agents are running (#499)", () => {
    render(row({ running: 2, paused: 1 }));
    expect(screen.getByText(/2 agents running/)).toBeTruthy();
    expect(screen.getByText(/1 paused/)).toBeTruthy();
  });

  it("shows open count + closed-fraction progress (#499)", () => {
    render(row());
    // 1 open of 3 items (2 closed) → 67%.
    expect(screen.getByText("1")).toBeTruthy(); // open count
    expect(screen.getByText("67%")).toBeTruthy();
  });

  it("calls onBoard when 'open board on GitHub' is clicked", () => {
    const onBoard = vi.fn();
    render(row({ onBoard }));
    fireEvent.click(screen.getByText("open board on GitHub"));
    expect(onBoard).toHaveBeenCalledWith(mockProject);
  });

  it("calls onDelete when 'delete project' is clicked with the menu open", () => {
    const onDelete = vi.fn();
    render(row({ onDelete }));
    fireEvent.click(screen.getByText("delete project"));
    expect(onDelete).toHaveBeenCalledWith(mockProject);
  });

  it("does not render the menu when this row isn't the open one", () => {
    render(row({ menuOpenId: null }));
    expect(screen.queryByText("delete project")).not.toBeInTheDocument();
  });
});
