// TreeExplorerPage (#2505) — the tree-shaped page composition: the indented Tree rail under the
// header bar, selection driving the node-facts KeyValueList detail, and the detail/facts overrides.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TreeExplorerPage, type TreeNodeData } from "./TreeExplorerPage";

const NODES: TreeNodeData[] = [
  {
    id: "src", label: "src", meta: "dir",
    children: [
      { id: "app", label: "app", children: [{ id: "main", label: "main.tsx" }] },
      { id: "shared", label: "shared" },
    ],
  },
];

describe("TreeExplorerPage — rendering", () => {
  it("renders the header bar and the indented tree rail (rows for every visible node)", () => {
    render(<TreeExplorerPage title="Files" hint="src/" nodes={NODES} />);
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.getByText("src/")).toBeInTheDocument();
    expect(screen.getAllByRole("treeitem")).toHaveLength(4); // all expanded by default
  });

  it("shows the no-selection empty state until a node is picked", () => {
    render(<TreeExplorerPage title="Files" nodes={NODES} />);
    expect(screen.getByText("No node selected")).toBeInTheDocument();
  });

  it("respects defaultCollapsedIds (collapsed branches hide their rows)", () => {
    render(<TreeExplorerPage title="Files" nodes={NODES} defaultCollapsedIds={["app"]} />);
    expect(screen.queryByText("main.tsx")).toBeNull();
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
  });
});

describe("TreeExplorerPage — selection drives the detail", () => {
  it("uncontrolled: clicking a node renders its facts (id · meta · children) as a KeyValueList", () => {
    const onSelect = vi.fn();
    render(<TreeExplorerPage title="Files" nodes={NODES} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("src"));
    expect(onSelect).toHaveBeenCalledWith("src");
    expect(screen.getByText("id")).toBeInTheDocument();
    expect(screen.getByText("children")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();     // src has two children
    expect(screen.getAllByText("dir").length).toBeGreaterThan(1); // rail meta + detail fact
  });

  it("appends nodeFacts to the default detail", () => {
    render(<TreeExplorerPage title="Files" nodes={NODES} defaultSelectedId="main"
      nodeFacts={(n) => [{ k: "path", v: `src/app/${n.label}` }]} />);
    expect(screen.getByText("path")).toBeInTheDocument();
    expect(screen.getByText("src/app/main.tsx")).toBeInTheDocument();
  });

  it("controlled: selectedId drives the detail; detail render-prop overrides the default", () => {
    render(<TreeExplorerPage title="Files" nodes={NODES} selectedId="shared"
      detail={(n) => <span>NODE:{n.id}</span>} />);
    expect(screen.getByText("NODE:shared")).toBeInTheDocument();
  });
});
