// networkLayout (#2505) — the pure model behind NetworkPage: the shared graph stack (findBackEdges +
// layerDag + orderLayers) over arbitrary directed input, plus the centered-row placement.
import { describe, it, expect } from "vitest";
import { layoutNetwork, networkEdges, NET_NODE_W, NET_NODE_H, type NetworkNodeData } from "./networkLayout";

const NODES: NetworkNodeData[] = [
  { id: "api", label: "api" },
  { id: "ui", label: "ui" },
  { id: "db", label: "db" },
  { id: "docs", label: "docs" }, // isolated
];
const EDGES = [
  { from: "api", to: "ui" },
  { from: "db", to: "api" },
];

describe("layoutNetwork — layering rides the shared graph stack", () => {
  it("assigns each node its longest-path layer (from → deeper) and derives missing edge ids", () => {
    const l = layoutNetwork(NODES, EDGES);
    expect(l.layer.db).toBe(0);
    expect(l.layer.api).toBe(1);
    expect(l.layer.ui).toBe(2);
    expect(l.layer.docs).toBe(0); // no in-edges → a source row
    expect(l.edges.map((e) => e.id)).toContain("api->ui");
  });

  it("positions every node and stacks layers top-down with the metric gaps", () => {
    const l = layoutNetwork(NODES, EDGES);
    for (const n of NODES) expect(l.pos.get(n.id), n.id).toBeTruthy();
    expect(l.pos.get("db")!.y).toBeLessThan(l.pos.get("api")!.y);
    expect(l.pos.get("api")!.y).toBeLessThan(l.pos.get("ui")!.y);
    // The world box contains every card.
    for (const { x, y } of l.pos.values()) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + NET_NODE_W).toBeLessThanOrEqual(l.world.w);
      expect(y + NET_NODE_H).toBeLessThanOrEqual(l.world.h);
    }
  });

  it("tolerates cycles: layering breaks the back-edge, drawing keeps every edge", () => {
    const cyc = [...EDGES, { from: "ui", to: "db" }]; // db → api → ui → db
    const l = layoutNetwork(NODES, cyc);
    expect(l.edges).toHaveLength(3);                  // the cycle edge still draws
    expect(l.layer.db).toBe(0);                       // …but does not diverge the layers
    expect(l.layer.ui).toBe(2);
  });

  it("networkEdges keeps explicit ids and derives `from->to` for the rest", () => {
    const edges = networkEdges([{ id: "e1", from: "a", to: "b" }, { from: "b", to: "c" }]);
    expect(edges.map((e) => e.id)).toEqual(["e1", "b->c"]);
  });

  it("handles an empty graph without dividing by zero", () => {
    const l = layoutNetwork([], []);
    expect(l.world.w).toBeGreaterThan(0);
    expect(l.world.h).toBeGreaterThan(0);
    expect(l.pos.size).toBe(0);
  });
});
