import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TreeView } from "./TreeView";
import type { TreeFrame } from "../../lib/trace";

const frame = (over: Partial<TreeFrame>): TreeFrame => ({
  structure: "tree",
  nodes: [
    { id: "r", value: 5 },
    { id: "a", value: 8, parent: "r" },
    { id: "b", value: 3, parent: "r" },
  ],
  ...over,
});

describe("TreeView (#3270)", () => {
  it("draws a node per entry + an edge from each non-root node to its parent", () => {
    const { container } = render(<TreeView frame={frame({})} />);
    expect(container.querySelectorAll(".tree-node").length).toBe(3);
    expect(container.querySelectorAll(".tree-edge").length).toBe(2); // a→r, b→r (the root has no parent edge)
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
  });

  it("stamps data-op on the acting node's circle", () => {
    const c = render(<TreeView frame={frame({ ops: [{ op: "insert", node: "a", parent: "r" }] })} />).container;
    const circle = c.querySelector('.tree-node[data-op="insert"]');
    expect(circle).not.toBeNull();
    expect(circle?.nextElementSibling?.textContent).toBe("8"); // the inserted node is `a` (value 8)
  });

  it("stamps swap on BOTH sifted nodes (the `at` id pair)", () => {
    const c = render(<TreeView frame={frame({ ops: [{ op: "swap", at: ["r", "a"] }] })} />).container;
    expect(c.querySelectorAll('.tree-node[data-op="swap"]').length).toBe(2);
  });

  it("paints a durable mark from the frame's marks", () => {
    const c = render(<TreeView frame={frame({ marks: { r: "current" } })} />).container;
    expect(c.querySelector('.tree-node[data-mark="current"]')).not.toBeNull();
  });

  it("shows an empty state when the tree has no nodes", () => {
    render(<TreeView frame={frame({ nodes: [] })} />);
    expect(screen.getByText("(empty)")).toBeInTheDocument();
  });
});
