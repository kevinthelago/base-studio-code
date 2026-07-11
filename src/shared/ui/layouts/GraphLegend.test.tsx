// GraphLegend (#2909) — the shared on-canvas graph legend.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GraphLegend } from "./GraphLegend";

describe("GraphLegend", () => {
  it("renders node + edge rows for non-empty sections", () => {
    render(
      <GraphLegend
        sections={[
          { label: "Roles", nodes: [{ label: "Primitive", color: "var(--violet)" }] },
          { label: "Relationships", edges: [{ label: "composes" }, { label: "pairs", dashed: true }] },
        ]}
      />,
    );
    expect(screen.getByText("Roles")).toBeTruthy();
    expect(screen.getByText("Primitive")).toBeTruthy();
    expect(screen.getByText("composes")).toBeTruthy();
    expect(screen.getByText("pairs")).toBeTruthy();
  });

  it("renders nothing when every section is empty", () => {
    const { container } = render(<GraphLegend sections={[{ label: "Empty" }, { label: "Also", nodes: [] }]} />);
    expect(container.querySelector(".graph-legend")).toBeNull();
  });
});
