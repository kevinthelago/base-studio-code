// PaneGrid (#2197 slice 2) — the CSS-grid-of-N-panes skeleton: a `cols × rows` grid that flexes to
// fill, with a uniform gap/padding, hosting N pane cells. `hidden` keeps a grid mounted but
// display:none (the Console's cross-tab pane survival).
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PaneGrid } from "./PaneGrid";

function panes(n: number) {
  return Array.from({ length: n }, (_, i) => <span key={i} data-testid={`pane-${i}`}>{`P${i}`}</span>);
}

describe("PaneGrid (#2197)", () => {
  it("renders every pane child as a grid cell", () => {
    render(<PaneGrid cols={2} rows={2}>{panes(4)}</PaneGrid>);
    for (let i = 0; i < 4; i++) expect(screen.getByTestId(`pane-${i}`)).toBeInTheDocument();
  });

  it("lays out the requested cols × rows tracks", () => {
    const { container } = render(<PaneGrid cols={3} rows={2}>{panes(6)}</PaneGrid>);
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.style.display).toBe("grid");
    expect(grid.style.gridTemplateColumns).toBe("repeat(3, 1fr)");
    expect(grid.style.gridTemplateRows).toBe("repeat(2, 1fr)");
  });

  it("clamps degenerate cols/rows to at least one track", () => {
    const { container } = render(<PaneGrid cols={0} rows={0}>{panes(1)}</PaneGrid>);
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("repeat(1, 1fr)");
    expect(grid.style.gridTemplateRows).toBe("repeat(1, 1fr)");
  });

  it("applies the default gap + padding, overridable", () => {
    const { container } = render(<PaneGrid cols={1} rows={1}>{panes(1)}</PaneGrid>);
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.style.gap).toBe("8px");
    expect(grid.style.padding).toBe("10px");
    const custom = render(<PaneGrid cols={1} rows={1} gap={4} pad={2}>{panes(1)}</PaneGrid>);
    const cgrid = custom.container.firstElementChild as HTMLElement;
    expect(cgrid.style.gap).toBe("4px");
    expect(cgrid.style.padding).toBe("2px");
  });

  it("goes display:none when hidden but keeps its panes mounted", () => {
    const { container } = render(<PaneGrid cols={1} rows={1} hidden>{panes(1)}</PaneGrid>);
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.style.display).toBe("none");
    // Still mounted — the child DOM survives so background-tab terminals stay alive.
    expect(screen.getByTestId("pane-0")).toBeInTheDocument();
  });

  it("forwards className (page scoping hook) and a style escape hatch", () => {
    const { container } = render(
      <PaneGrid cols={1} rows={1} className="console-grid" style={{ background: "red" }}>{panes(1)}</PaneGrid>,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.classList.contains("console-grid")).toBe(true);
    expect(grid.style.background).toBe("red");
  });
});
