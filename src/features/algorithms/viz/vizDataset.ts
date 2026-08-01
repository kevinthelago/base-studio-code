// vizRunToDataset (#2940): extract a plain, component-consumable DATASET from a sandbox VizRun — the
// bridge that lets a librarian ALGORITHM feed a designer COMPONENT's preview (the studio-network payoff).
//
// A VizRun is `{ datatype, input, frames }` where each Frame carries a fresh snapshot of the structure's
// data. The algorithm's OUTPUT is the LAST snapshot frame — a sort's sorted array, a matrix op's
// transformed grid, a graph layout's positioned nodes — falling back to the seed `input` when a run has
// no snapshot frames. The result is normalized so a component preview can bind a data prop straight to it
// (e.g. a `graph` dataset → a ForceGraph's `{ nodes, edges }`), with no per-component adapter.
import type { VizRun } from "./examples/vizProgram";
import type { GraphInput } from "../lib/tracer";

/** A nested tree node (#3790) — a `{ id, label, children? }` forest node, structurally the shared
 *  Tree/TreeExplorerPage `nodes` prop shape (`TreeNodeData`), so it binds directly. */
export interface TreeDatasetNode {
  id: string;
  label: string;
  children?: TreeDatasetNode[];
}

/** A normalized dataset extracted from a run — discriminated by the run's datatype, structurally-cloneable
 *  and directly bindable to a component prop. `graph` covers both the `graph` and `scene` datatypes; `tree`
 *  (#3790) is a NESTED forest (built from a BST's pure shape, not a run — see `datasetForStructure`). */
export type VizDataset =
  | { kind: "array"; data: number[] }
  | { kind: "matrix"; data: number[][] }
  | { kind: "graph"; nodes: GraphInput["nodes"]; edges: GraphInput["edges"] }
  | { kind: "tree"; roots: TreeDatasetNode[] };

// Frames are snapshots; we read the last one that carries the structure's data. Typed loosely here
// (the tracer's Frame union lives module-private) — we only touch the snapshot fields we extract.
type Snapshot = {
  structure?: string;
  data?: number[] | number[][];
  nodes?: GraphInput["nodes"];
  edges?: GraphInput["edges"];
};

/** A tree frame's parent-pointer node list — the shape `TracedTree` snapshots (#4162). Read separately
 *  from {@link Snapshot} because a graph node and a tree node share only the `id` field. */
type TreeSnapshotNode = { id: string; value: number | string; parent?: string };

/** The last frame that carries a structural snapshot (the algorithm's settled output), or undefined. */
function lastSnapshot(frames: readonly unknown[]): Snapshot | undefined {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i] as Snapshot;
    if (f && (f.data !== undefined || f.nodes !== undefined)) return f;
  }
  return undefined;
}

/** Nest a parent-pointer node list into a forest (#4162). Children keep their snapshot order, so a BST
 *  reads left-then-right. Orphans (a `parent` naming no node) are promoted to roots rather than dropped —
 *  a partial tree is still worth showing, and silently losing nodes would misrepresent the algorithm. */
function nestByParent(nodes: readonly TreeSnapshotNode[]): TreeDatasetNode[] {
  const byId = new Map<string, TreeDatasetNode>(
    nodes.map((n) => [n.id, { id: n.id, label: String(n.value) }]),
  );
  const roots: TreeDatasetNode[] = [];
  for (const n of nodes) {
    const node = byId.get(n.id);
    if (!node) continue;
    const parent = n.parent !== undefined ? byId.get(n.parent) : undefined;
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * Normalize a {@link VizRun} into a {@link VizDataset} a component preview can bind to. Prefers the
 * algorithm's FINAL snapshot (its computed output); falls back to the run's seed `input` so a run that
 * recorded no snapshot frames still yields the shaped data.
 *
 * `undefined` for the `stack` and `scalar` datatypes (#4162): a stack's contents are a mixed
 * number/string sequence and a scalar run is a NAMED variable map — neither is any of the three dataset
 * shapes a component prop binds to. Returning a coerced `array` for them would hand a component a
 * plausible-looking dataset that means something else, which is worse than having none.
 */
export function vizRunToDataset(run: VizRun): VizDataset | undefined {
  const snap = lastSnapshot(run.frames);
  switch (run.datatype) {
    case "tree": {
      // The tracer's tree frames carry the parent pointers; nesting them is the whole conversion.
      const nodes = (snap?.nodes as TreeSnapshotNode[] | undefined) ?? [];
      return { kind: "tree", roots: nestByParent(nodes) };
    }
    case "stack":
    case "scalar":
      return undefined;
    case "array": {
      const data = (snap?.data as number[] | undefined) ?? (run.input as number[]);
      return { kind: "array", data: [...(data ?? [])] };
    }
    case "matrix": {
      const data = (snap?.data as number[][] | undefined) ?? (run.input as number[][]);
      return { kind: "matrix", data: (data ?? []).map((row) => [...row]) };
    }
    case "graph":
    case "scene": {
      const seed = run.input as GraphInput;
      const nodes = snap?.nodes ?? seed?.nodes ?? [];
      const edges = snap?.edges ?? seed?.edges ?? [];
      return { kind: "graph", nodes: nodes.map((n) => ({ ...n })), edges: edges.map((e) => ({ ...e })) };
    }
  }
}
