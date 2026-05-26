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

// Regression guard: the row's ⋯ menu items must reach their handlers. The bug
// was an eager document-mousedown handler that closed the menu before the item's
// click fired, so delete/edit never ran.
describe("ProjectRow menu", () => {
  it("calls onDelete when 'delete project' is clicked with the menu open", () => {
    const onDelete = vi.fn();
    render(
      <ProjectRow
        p={mockProject}
        onOpen={() => {}}
        onEdit={() => {}}
        onDelete={onDelete}
        menuOpenId={mockProject.id}
        setMenuOpenId={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("delete project"));
    expect(onDelete).toHaveBeenCalledWith(mockProject);
  });

  it("calls onEdit when 'plan / edit' is clicked", () => {
    const onEdit = vi.fn();
    render(
      <ProjectRow
        p={mockProject}
        onOpen={() => {}}
        onEdit={onEdit}
        onDelete={() => {}}
        menuOpenId={mockProject.id}
        setMenuOpenId={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("plan / edit"));
    expect(onEdit).toHaveBeenCalledWith(mockProject);
  });

  it("does not render the menu when this row isn't the open one", () => {
    render(
      <ProjectRow
        p={mockProject}
        onOpen={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        menuOpenId={null}
        setMenuOpenId={() => {}}
      />,
    );
    expect(screen.queryByText("delete project")).not.toBeInTheDocument();
  });
});
