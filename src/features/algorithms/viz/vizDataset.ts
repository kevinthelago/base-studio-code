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

/** The last frame that carries a structural snapshot (the algorithm's settled output), or undefined. */
function lastSnapshot(frames: readonly unknown[]): Snapshot | undefined {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i] as Snapshot;
    if (f && (f.data !== undefined || f.nodes !== undefined)) return f;
  }
  return undefined;
}

/**
 * Normalize a {@link VizRun} into a {@link VizDataset} a component preview can bind to. Prefers the
 * algorithm's FINAL snapshot (its computed output); falls back to the run's seed `input` so a run that
 * recorded no snapshot frames still yields the shaped data.
 */
export function vizRunToDataset(run: VizRun): VizDataset {
  const snap = lastSnapshot(run.frames);
  switch (run.datatype) {
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
