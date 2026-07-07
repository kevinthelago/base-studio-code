// NetworkPage (#2505) — the graph-shaped page composition: GraphCanvas chrome over typed
// { nodes, edges }, shared-grammar edges, and selection driving the node-facts inspector.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NetworkPage, type NetworkNodeData, type NetworkEdgeData } from "./NetworkPage";
import { layoutNetwork } from "./networkLayout";

const NODES: NetworkNodeData[] = [
  { id: "api", label: "api", meta: "3 issues" },
  { id: "ui", label: "ui" },
  { id: "db", label: "db" },
];
const EDGES: NetworkEdgeData[] = [
  { from: "db", to: "api" },
  { from: "api", to: "ui" },
];

describe("NetworkPage — rendering", () => {
  it("renders a positioned [data-node] card per node at its layoutNetwork position", () => {
    const { container } = render(<NetworkPage title="Streams" nodes={NODES} edges={EDGES} />);
    const cards = container.querySelectorAll("[data-node]");
    expect(cards).toHaveLength(3);
    const layout = layoutNetwork(NODES, EDGES);
    const card = container.querySelector('[data-node="db"]') as HTMLElement;
    const p = layout.pos.get("db")!;
    expect(card.style.left).toBe(`${p.x}px`);
    expect(card.style.top).toBe(`${p.y}px`);
  });

  it("draws one shared-grammar edge (curve + arrowhead) per link", () => {
    const { container } = render(<NetworkPage title="Streams" nodes={NODES} edges={EDGES} />);
    const edgeGroups = container.querySelectorAll("svg g");
    expect(edgeGroups).toHaveLength(EDGES.length);
    for (const g of edgeGroups) expect(g.querySelectorAll("path")).toHaveLength(2);
  });

  it("mounts the GraphCanvas chrome: title, hint, extra toolbar, zoom cluster, fit", () => {
    render(<NetworkPage title="Streams" hint="deps" toolbar={<span>NET-TOOLS</span>} nodes={NODES} edges={EDGES} />);
    expect(screen.getByText("Streams")).toBeInTheDocument();
    expect(screen.getByText("deps")).toBeInTheDocument();
    expect(screen.getByText("NET-TOOLS")).toBeInTheDocument();
    expect(screen.getByLabelText("zoom in")).toBeInTheDocument();
    expect(screen.getByLabelText("fit graph")).toBeInTheDocument();
  });
});

describe("NetworkPage — selection drives the inspector", () => {
  it("uncontrolled: clicking a card selects it and renders the facts inspector (id · meta · degree)", () => {
    const onSelect = vi.fn();
    const { container } = render(<NetworkPage title="Streams" nodes={NODES} edges={EDGES} onSelect={onSelect} />);
    fireEvent.click(container.querySelector('[data-node="api"]') as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("api");
    expect((container.querySelector('[data-node="api"]') as HTMLElement).dataset.selected).toBe("true");
    expect(screen.getByText("in")).toBeInTheDocument();
    expect(screen.getByText("out")).toBeInTheDocument();
    expect(screen.getAllByText("3 issues").length).toBeGreaterThan(1); // card meta + inspector fact
  });

  it("hides the inspector until a node is selected", () => {
    const { container } = render(<NetworkPage title="Streams" nodes={NODES} edges={EDGES} />);
    expect(container.textContent).not.toContain("out");
  });

  it("controlled: selectedId highlights the card; detail render-prop overrides the default", () => {
    const { container } = render(
      <NetworkPage title="Streams" nodes={NODES} edges={EDGES} selectedId="ui"
        detail={(n) => <span>INSPECT:{n.id}</span>} />,
    );
    expect((container.querySelector('[data-node="ui"]') as HTMLElement).dataset.selected).toBe("true");
    expect(screen.getByText("INSPECT:ui")).toBeInTheDocument();
  });
});
