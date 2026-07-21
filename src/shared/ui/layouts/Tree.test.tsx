// Tree (#2476, Layouts tier #2197) — the tree page template: the INDENTED file-explorer variant
// (collapsible depth-indented rows + detail) and the LAYERED org-chart variant (top-down cards +
// shared-edge SVG inside a GraphCanvas).
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Tree } from "./Tree";
import { layoutTree, treeEdges, flattenTree, type TreeNodeData } from "./treeLayout";

const NODES: TreeNodeData[] = [
  {
    id: "root", label: "src", meta: "12 files",
    children: [
      { id: "app", label: "app", children: [{ id: "main", label: "main.tsx" }] },
      { id: "shared", label: "shared", children: [{ id: "ui", label: "ui" }] },
      { id: "readme", label: "README.md" },
    ],
  },
];

const row = (label: string): HTMLElement => {
  const el = screen.getByText(label).closest('[role="treeitem"]');
  expect(el, `row ${label}`).toBeTruthy();
  return el as HTMLElement;
};

describe("Tree — indented variant (#2476)", () => {
  it("renders every node as a treeitem row, fully expanded by default", () => {
    render(<Tree nodes={NODES} />);
    expect(screen.getByRole("tree")).toBeInTheDocument();
    expect(screen.getAllByRole("treeitem")).toHaveLength(6);
    expect(screen.getByText("main.tsx")).toBeInTheDocument();
    expect(screen.getByText("12 files")).toBeInTheDocument(); // meta renders
  });

  it("indents rows by depth", () => {
    render(<Tree nodes={NODES} indent={20} />);
    expect(row("src").style.paddingLeft).toBe("6px");        // depth 0
    expect(row("app").style.paddingLeft).toBe("26px");       // depth 1
    expect(row("main.tsx").style.paddingLeft).toBe("46px");  // depth 2
  });

  it("collapses and re-expands a branch via the chevron, notifying onToggle", () => {
    const onToggle = vi.fn();
    render(<Tree nodes={NODES} onToggle={onToggle} />);
    expect(row("app").getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByLabelText("collapse app"));
    expect(screen.queryByText("main.tsx")).toBeNull();
    expect(row("app").getAttribute("aria-expanded")).toBe("false");
    expect(onToggle).toHaveBeenLastCalledWith("app", false);
    // Siblings' subtrees are untouched.
    expect(screen.getByText("ui")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("expand app"));
    expect(screen.getByText("main.tsx")).toBeInTheDocument();
    expect(onToggle).toHaveBeenLastCalledWith("app", true);
  });

  it("starts collapsed for defaultCollapsedIds branches", () => {
    render(<Tree nodes={NODES} defaultCollapsedIds={["app"]} />);
    expect(screen.queryByText("main.tsx")).toBeNull();
    expect(screen.getByLabelText("expand app")).toBeInTheDocument();
  });

  it("leaf rows have no chevron and no aria-expanded", () => {
    render(<Tree nodes={NODES} />);
    expect(row("README.md").getAttribute("aria-expanded")).toBeNull();
    expect(screen.queryByLabelText("collapse README.md")).toBeNull();
  });

  it("uncontrolled selection: clicking a row selects it and fires onSelect; the detail fn gets the node", () => {
    const onSelect = vi.fn();
    render(
      <Tree nodes={NODES} onSelect={onSelect}
        detail={(n) => <span>DETAIL:{n ? n.label : "none"}</span>} />,
    );
    expect(screen.getByText("DETAIL:none")).toBeInTheDocument();

    fireEvent.click(screen.getByText("README.md"));
    expect(onSelect).toHaveBeenCalledWith("readme");
    expect(row("README.md").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("DETAIL:README.md")).toBeInTheDocument();
  });

  it("keyboard selection: Enter on a focused row selects it", () => {
    const onSelect = vi.fn();
    render(<Tree nodes={NODES} onSelect={onSelect} />);
    fireEvent.keyDown(row("app"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("app");
    expect(row("app").getAttribute("aria-selected")).toBe("true");
  });

  it("controlled selection: selectedId drives the highlight; a click only fires onSelect", () => {
    const onSelect = vi.fn();
    render(<Tree nodes={NODES} selectedId="app" onSelect={onSelect} />);
    expect(row("app").getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByText("README.md"));
    expect(onSelect).toHaveBeenCalledWith("readme");
    // Controlled — the highlight does NOT move on its own.
    expect(row("app").getAttribute("aria-selected")).toBe("true");
    expect(row("README.md").getAttribute("aria-selected")).toBe("false");
  });

  it("the chevron toggles without selecting the row", () => {
    const onSelect = vi.fn();
    render(<Tree nodes={NODES} onSelect={onSelect} />);
    fireEvent.click(screen.getByLabelText("collapse app"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(row("app").getAttribute("aria-selected")).toBe("false");
  });

  it("renders the toolbar slot and a resizable rail splitter on request", () => {
    const { container } = render(<Tree nodes={NODES} toolbar={<span>TOOLBAR</span>} resizable />);
    expect(screen.getByText("TOOLBAR")).toBeInTheDocument();
    expect(container.querySelector(".resize-x")).not.toBeNull();
  });

  it("has no splitter by default", () => {
    const { container } = render(<Tree nodes={NODES} />);
    expect(container.querySelector(".resize-x")).toBeNull();
  });
});

describe("Tree — layered variant (#2476)", () => {
  it("renders a positioned [data-node] card per node at its layoutTree position", () => {
    const { container } = render(<Tree nodes={NODES} variant="layered" />);
    const cards = container.querySelectorAll("[data-node]");
    expect(cards).toHaveLength(6);
    const layout = layoutTree(NODES);
    const rootCard = container.querySelector('[data-node="root"]') as HTMLElement;
    const p = layout.pos.get("root")!;
    expect(rootCard.style.left).toBe(`${p.x}px`);
    expect(rootCard.style.top).toBe(`${p.y}px`);
  });

  it("draws one shared-grammar edge (curve + arrowhead) per parent→child link", () => {
    const { container } = render(<Tree nodes={NODES} variant="layered" />);
    const edgeGroups = container.querySelectorAll("svg g");
    expect(edgeGroups).toHaveLength(treeEdges(flattenTree(NODES)).length); // 5
    for (const g of edgeGroups) expect(g.querySelectorAll("path")).toHaveLength(2);
  });

  it("mounts the GraphCanvas chrome: zoom cluster, fit, and the toolbar slot", () => {
    render(<Tree nodes={NODES} variant="layered" toolbar={<span>TREE-TOOLBAR</span>} />);
    expect(screen.getByText("TREE-TOOLBAR")).toBeInTheDocument();
    expect(screen.getByLabelText("zoom in")).toBeInTheDocument();
    expect(screen.getByLabelText("zoom out")).toBeInTheDocument();
    expect(screen.getByLabelText("fit tree")).toBeInTheDocument();
  });

  it("selects a node on card click (data-selected) and shows the detail inspector", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Tree nodes={NODES} variant="layered" onSelect={onSelect}
        detail={(n) => (n ? <span>INSPECT:{n.label}</span> : null)} />,
    );
    fireEvent.click(container.querySelector('[data-node="shared"]') as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("shared");
    expect((container.querySelector('[data-node="shared"]') as HTMLElement).dataset.selected).toBe("true");
    expect(screen.getByText("INSPECT:shared")).toBeInTheDocument();
  });

  it("controlled selection highlights the given card", () => {
    const { container } = render(<Tree nodes={NODES} variant="layered" selectedId="ui" />);
    expect((container.querySelector('[data-node="ui"]') as HTMLElement).dataset.selected).toBe("true");
    expect((container.querySelector('[data-node="root"]') as HTMLElement).dataset.selected).toBeUndefined();
  });

  it("sizes the GraphCanvas world layer to the tree layout's world", () => {
    const { container } = render(<Tree nodes={NODES} variant="layered" />);
    const layout = layoutTree(NODES);
    const svg = container.querySelector("svg") as SVGElement;
    const worldLayer = svg.parentElement as HTMLElement;
    expect(worldLayer.style.width).toBe(`${layout.world.w}px`);
    expect(worldLayer.style.height).toBe(`${layout.world.h}px`);
  });
});
