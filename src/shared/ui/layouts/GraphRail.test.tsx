// GraphRail (#2767) — the shared graph-page left rail: header (label · count) · optional tools · scroll
// body · optional footer. These lock the slots the three graph pages (Teams/Glance/Designs) depend on.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GraphRail } from "./GraphRail";

describe("GraphRail", () => {
  it("renders the label + count header over the scroll body", () => {
    render(<GraphRail label="Projects" count={7}><div>row-a</div></GraphRail>);
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("row-a")).toBeInTheDocument();
  });

  it("hides the count slot when count is null/undefined (but shows an explicit 0)", () => {
    const { rerender } = render(<GraphRail label="Positions"><div>x</div></GraphRail>);
    // No count passed → only the label renders in the header.
    expect(screen.getByText("Positions")).toBeInTheDocument();
    expect(screen.queryByText("0")).toBeNull();
    // An explicit 0 IS shown (a real, if empty, count).
    rerender(<GraphRail label="Positions" count={0}><div>x</div></GraphRail>);
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("renders the optional tools strip (e.g. a search field) and the pinned footer", () => {
    render(
      <GraphRail
        label="Kits · Components"
        count="3 comps"
        tools={<input aria-label="Search" />}
        footer={<div>hazards</div>}
      >
        <div>tree</div>
      </GraphRail>,
    );
    expect(screen.getByLabelText("Search")).toBeInTheDocument();
    expect(screen.getByText("3 comps")).toBeInTheDocument();
    expect(screen.getByText("hazards")).toBeInTheDocument();
    expect(screen.getByText("tree")).toBeInTheDocument();
  });
});
