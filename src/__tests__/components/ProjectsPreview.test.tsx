import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MiniProjRow, ProjectPreview } from "../../screens/projects/ProjectsList";

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
  repositories: { nodes: [{ nameWithOwner: "o/a" }, { nameWithOwner: "o/b" }] },
};

function preview(over: Partial<Parameters<typeof ProjectPreview>[0]> = {}) {
  return (
    <ProjectPreview
      p={mockProject}
      fleet={{ running: 0, paused: 0 }}
      menuOpen={false}
      setMenuOpen={() => {}}
      menuRef={{ current: null }}
      onBoard={() => {}}
      onPlan={() => {}}
      onDelete={() => {}}
      {...over}
    />
  );
}

describe("MiniProjRow (master list)", () => {
  it("renders the title + item count and fires onSelect", () => {
    const onSelect = vi.fn();
    render(<MiniProjRow p={mockProject} selected={false} onSelect={onSelect} />);
    expect(screen.getByText("My App")).toBeTruthy();
    fireEvent.click(screen.getByText("My App"));
    expect(onSelect).toHaveBeenCalled();
  });
});

describe("ProjectPreview (detail pane)", () => {
  it("shows real KPIs incl. the computed done%", () => {
    render(preview());
    expect(screen.getByText("items")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
    // 2 closed of 3 tracked → 67%.
    expect(screen.getByText("67%")).toBeTruthy();
    // Item-progress card reflects the same counts.
    expect(screen.getByText("Item progress")).toBeTruthy();
  });

  it("shows the live fleet pill when agents are running", () => {
    render(preview({ fleet: { running: 2, paused: 1 } }));
    expect(screen.getByText(/2 agents running/)).toBeTruthy();
    expect(screen.getByText(/1 paused/)).toBeTruthy();
  });

  it("calls onPlan and onBoard from the header", () => {
    const onPlan = vi.fn(), onBoard = vi.fn();
    render(preview({ onPlan, onBoard }));
    fireEvent.click(screen.getByText("plan →"));
    expect(onPlan).toHaveBeenCalled();
    fireEvent.click(screen.getAllByText("open board")[0]);
    expect(onBoard).toHaveBeenCalled();
  });

  it("calls onDelete from the ⋯ menu when open", () => {
    const onDelete = vi.fn();
    render(preview({ menuOpen: true, onDelete }));
    fireEvent.click(screen.getByText("delete project"));
    expect(onDelete).toHaveBeenCalled();
  });
});
