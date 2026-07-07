// Tree layout (#2476, Layouts tier #2197) — the pure (React-free) model behind the Tree template's
// LAYERED variant. A tree is a single-parent DAG, so the placement is exactly the shared graph
// stack: `layerDag` (#2214) assigns each node its depth (roots at layer 0), `orderLayers` (#2418)
// runs the shared barycenter sweep so subtrees stay grouped under their parent, and this module owns
// only the layer→pixel PLACEMENT (centered rows, top-down) — the same discipline as the Design
// Studio's `compositionLayout` (#2455). Nothing here forks graph logic; it only feeds the shared
// pieces tree-shaped input.
import { layerDag } from "@/shared/lib/graph/layers";
import { orderLayers } from "@/shared/lib/graph/order";
import type { GraphEdge } from "@/shared/lib/graph/types";

/** The recursive node the Tree template takes — ids must be unique across the whole tree. */
export interface TreeNodeData {
  id: string;
  label: string;
  /** Optional dimmed mono meta after the label (a count, a kind, a size). */
  meta?: string;
  children?: TreeNodeData[];
}

/** One node of the flattened tree, with its parent link and indentation depth. */
export interface FlatTreeNode {
  node: TreeNodeData;
  parentId?: string;
  depth: number;
}

/** Depth-first flatten (pre-order) — the indented variant's row order and the layout's seed order. */
export function flattenTree(nodes: readonly TreeNodeData[]): FlatTreeNode[] {
  const out: FlatTreeNode[] = [];
  const walk = (list: readonly TreeNodeData[], parentId: string | undefined, depth: number) => {
    for (const node of list) {
      out.push({ node, parentId, depth });
      if (node.children?.length) walk(node.children, node.id, depth + 1);
    }
  };
  walk(nodes, undefined, 0);
  return out;
}

/** The tree's parent→child edges in the shared `GraphEdge` shape. */
export function treeEdges(flat: readonly FlatTreeNode[]): GraphEdge[] {
  return flat
    .filter((f) => f.parentId !== undefined)
    .map((f) => ({ id: `${f.parentId}->${f.node.id}`, from: f.parentId as string, to: f.node.id }));
}

/** Node card box (world coords) — shared with the Tree component's node + edge rendering. */
export const TREE_NODE_W = 156;
export const TREE_NODE_H = 46;

export interface TreeLayoutMetrics {
  nodeW: number;
  nodeH: number;
  /** Horizontal clearance between siblings in a row. */
  hGap: number;
  /** Vertical clearance between layers (the gap the edges cross). */
  vGap: number;
  /** World padding around the whole layout. */
  pad: number;
}

export const DEFAULT_TREE_METRICS: TreeLayoutMetrics = {
  nodeW: TREE_NODE_W, nodeH: TREE_NODE_H, hGap: 26, vGap: 74, pad: 48,
};

export interface TreeLayout {
  /** Node id → its card's top-left corner in world coords. */
  pos: Map<string, { x: number; y: number }>;
  /** The parent→child edges (drawn with the shared edge grammar). */
  edges: GraphEdge[];
  /** World (design-space) size — the GraphCanvas `world` box. */
  world: { w: number; h: number };
  /** Node id → its layer (0 = roots). Exposed for tests + callers. */
  layer: Record<string, number>;
}

/**
 * Top-down tree placement: `layerDag` depth → row, shared barycenter ordering within each row
 * (neighbors = the hierarchy parent + children, sequential sweep — the Org discipline), rows
 * centered so parents sit over their subtrees.
 */
export function layoutTree(
  nodes: readonly TreeNodeData[],
  metrics: TreeLayoutMetrics = DEFAULT_TREE_METRICS,
): TreeLayout {
  const m = metrics;
  const flat = flattenTree(nodes);
  const ids = flat.map((f) => f.node.id);
  const edges = treeEdges(flat);
  const layer = layerDag(ids, edges);

  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    parentOf.set(e.to, e.from);
    const kids = childrenOf.get(e.from);
    if (kids) kids.push(e.to); else childrenOf.set(e.from, [e.to]);
  }
  const rows = orderLayers(
    ids,
    (id) => layer[id] ?? 0,
    (id) => {
      const p = parentOf.get(id);
      return p ? [p, ...(childrenOf.get(id) ?? [])] : childrenOf.get(id) ?? [];
    },
  );

  const rowWidth = (n: number) => n * m.nodeW + Math.max(0, n - 1) * m.hGap;
  const maxRow = Math.max(0, ...[...rows.values()].map((r) => r.length));
  const w = Math.max(320, 2 * m.pad + rowWidth(maxRow));

  const pos = new Map<string, { x: number; y: number }>();
  let bottom = m.pad;
  for (const [l, row] of [...rows.entries()].sort(([a], [b]) => a - b)) {
    const y = m.pad + l * (m.nodeH + m.vGap);
    const x0 = (w - rowWidth(row.length)) / 2; // center each row — parents sit over their subtree
    row.forEach((id, i) => pos.set(id, { x: x0 + i * (m.nodeW + m.hGap), y }));
    bottom = y + m.nodeH;
  }
  const h = Math.max(240, bottom + m.pad);

  return { pos, edges, world: { w, h }, layer };
}
