import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectRow } from "../../screens/projects/ProjectsList";

const mockProject = {
  id: "PVT_1",
  number: 7,
  title: "My App",
  shortDescription: "desc",
  url: "https://github.com/x",
  closed: false,
  updatedAt: new Date().toISOString(),
  items: { totalCount: 3 },
  repositories: { nodes: [{ nameWithOwner: "o/a" }] },
};

function row(over: Partial<Parameters<typeof ProjectRow>[0]> = {}) {
  return (
    <ProjectRow
      p={mockProject}
      onPlan={() => {}}
      onBoard={() => {}}
      onWorkspace={() => {}}
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
  it("plan is the primary action (#498)", () => {
    const onPlan = vi.fn();
    render(row({ onPlan }));
    fireEvent.click(screen.getByText("⌘ plan →"));
    expect(onPlan).toHaveBeenCalledWith(mockProject);
  });

  it("calls onBoard when 'board on GitHub' is clicked", () => {
    const onBoard = vi.fn();
    render(row({ onBoard }));
    fireEvent.click(screen.getByText("board on GitHub"));
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
