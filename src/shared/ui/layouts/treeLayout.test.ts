// treeLayout (#2476) — the pure model behind the Tree template's layered variant: DFS flatten,
// parent→child edges, and the top-down placement over the SHARED graph stack (layerDag + orderLayers).
import { describe, it, expect } from "vitest";
import {
  flattenTree, treeEdges, layoutTree,
  DEFAULT_TREE_METRICS, TREE_NODE_W, TREE_NODE_H,
  type TreeNodeData,
} from "./treeLayout";

const FIXTURE: TreeNodeData[] = [
  {
    id: "root", label: "src", meta: "12 files",
    children: [
      { id: "app", label: "app", children: [{ id: "main", label: "main.tsx" }] },
      { id: "shared", label: "shared", children: [{ id: "ui", label: "ui" }] },
      { id: "readme", label: "README.md" },
    ],
  },
];

describe("flattenTree / treeEdges (#2476)", () => {
  it("flattens depth-first (pre-order) with parent links + depths", () => {
    const flat = flattenTree(FIXTURE);
    expect(flat.map((f) => f.node.id)).toEqual(["root", "app", "main", "shared", "ui", "readme"]);
    expect(flat.map((f) => f.depth)).toEqual([0, 1, 2, 1, 2, 1]);
    expect(flat.find((f) => f.node.id === "main")?.parentId).toBe("app");
    expect(flat.find((f) => f.node.id === "root")?.parentId).toBeUndefined();
  });

  it("emits one parent→child edge per non-root node, in the shared GraphEdge shape", () => {
    const edges = treeEdges(flattenTree(FIXTURE));
    expect(edges).toHaveLength(5);
    expect(edges).toContainEqual({ id: "root->app", from: "root", to: "app" });
    expect(edges).toContainEqual({ id: "app->main", from: "app", to: "main" });
  });
});

describe("layoutTree (#2476) — layerDag depth → centered top-down rows", () => {
  it("assigns each node its tree depth as the layer (roots at 0)", () => {
    const { layer } = layoutTree(FIXTURE);
    expect(layer).toEqual({ root: 0, app: 1, shared: 1, readme: 1, main: 2, ui: 2 });
  });

  it("places every node, one row per layer, at the metric row pitch", () => {
    const m = DEFAULT_TREE_METRICS;
    const { pos, layer } = layoutTree(FIXTURE);
    for (const id of Object.keys(layer)) {
      const p = pos.get(id);
      expect(p, id).toBeTruthy();
      expect(p!.y).toBe(m.pad + layer[id] * (m.nodeH + m.vGap));
    }
  });

  it("centers each row in the world (a single root sits at the horizontal middle)", () => {
    const { pos, world } = layoutTree(FIXTURE);
    const root = pos.get("root")!;
    expect(root.x + TREE_NODE_W / 2).toBeCloseTo(world.w / 2);
  });

  it("sizes the world to the widest row + padding, and to the deepest row + padding", () => {
    const m = DEFAULT_TREE_METRICS;
    const { world } = layoutTree(FIXTURE);
    // widest row = the 3 children; deepest layer = 2.
    expect(world.w).toBe(2 * m.pad + 3 * m.nodeW + 2 * m.hGap);
    expect(world.h).toBe(m.pad + 2 * (m.nodeH + m.vGap) + TREE_NODE_H + m.pad);
  });

  it("keeps subtrees grouped: the barycenter order puts app's child left of shared's child", () => {
    const { pos } = layoutTree(FIXTURE);
    expect(pos.get("app")!.x).toBeLessThan(pos.get("shared")!.x);
    expect(pos.get("main")!.x).toBeLessThan(pos.get("ui")!.x);
  });

  it("lays a forest with several roots all on layer 0", () => {
    const forest: TreeNodeData[] = [
      { id: "a", label: "A", children: [{ id: "a1", label: "A1" }] },
      { id: "b", label: "B" },
    ];
    const { layer, pos } = layoutTree(forest);
    expect(layer.a).toBe(0);
    expect(layer.b).toBe(0);
    expect(layer.a1).toBe(1);
    expect(pos.get("a")!.y).toBe(pos.get("b")!.y);
  });

  it("handles an empty forest with a non-degenerate world", () => {
    const { pos, edges, world } = layoutTree([]);
    expect(pos.size).toBe(0);
    expect(edges).toHaveLength(0);
    expect(world.w).toBeGreaterThan(0);
    expect(world.h).toBeGreaterThan(0);
  });

  it("a single chain descends one layer per link", () => {
    const chain: TreeNodeData[] = [
      { id: "n0", label: "0", children: [{ id: "n1", label: "1", children: [{ id: "n2", label: "2", children: [{ id: "n3", label: "3" }] }] }] },
    ];
    const { layer } = layoutTree(chain);
    expect([layer.n0, layer.n1, layer.n2, layer.n3]).toEqual([0, 1, 2, 3]);
  });
});
