// previewDataset (#3439) — a SYNCHRONOUS, real dataset for a target STRUCTURE, sourced from a canonical
// in-app trace program (NOT the sandbox `vizCode` path — these programs are trusted app code that runs on
// the main thread). This is what lets the Design Studio's SHAPE tier feed a component that declares a
// `DataShape` with real algorithm-GENERATED data, with no per-component `PREVIEW_BINDINGS` row.
//
// Structures with BOTH a `VizDataset` kind and registered programs are offered — `array` (the sorts),
// `graph` (the traversals), and `tree` (a BST, #3790). Pure + deterministic (a fixed program + seed) so
// a preview never flickers between renders.
import { runAlgorithm, runGraphAlgorithm } from "../lib/tracer";
import { TRACE_PROGRAMS } from "./examples/sorts";
import { GRAPH_PROGRAMS } from "./examples/graphAlgos";
import { bstShape, TREE_PROGRAMS } from "./examples/treeAlgos";
import { vizRunToDataset, type VizDataset, type TreeDatasetNode } from "./vizDataset";

/** The structures the shape tier can source a real dataset for. */
export type PreviewStructure = "array" | "graph" | "tree";

/** Nest a `bstShape` (flat parent-pointer nodes + left/right child maps) into a `{ id, label, children }`
 *  forest node — the shared Tree component's `nodes` shape. Recurses left then right. */
function nestBst(shape: ReturnType<typeof bstShape>, id: string): TreeDatasetNode {
  const node = shape.nodes.find((n) => n.id === id);
  const children: TreeDatasetNode[] = [];
  const l = shape.left[id];
  if (l) children.push(nestBst(shape, l));
  const r = shape.right[id];
  if (r) children.push(nestBst(shape, r));
  return { id, label: String(node?.value ?? id), ...(children.length ? { children } : {}) };
}

/**
 * A real, algorithm-GENERATED dataset for `structure`, normalized to the shape a component preview binds
 * to: a sorted array, a traversed graph, or a BST forest (#3790). `undefined` only if no program is
 * registered (never in practice). Deterministic: a fixed program on its default seed, on the main thread.
 */
export function datasetForStructure(structure: PreviewStructure): VizDataset | undefined {
  if (structure === "array") {
    const program = Object.values(TRACE_PROGRAMS)[0];
    if (!program) return undefined;
    const frames = [...runAlgorithm(program.run, program.defaultInput)()];
    return vizRunToDataset({ datatype: "array", input: [...program.defaultInput], frames, source: "" });
  }
  if (structure === "graph") {
    const program = Object.values(GRAPH_PROGRAMS)[0];
    if (!program) return undefined;
    const frames = [...runGraphAlgorithm(program.run, program.defaultInput)()];
    return vizRunToDataset({ datatype: "graph", input: program.defaultInput, frames, source: "" });
  }
  // tree: the BST the tree programs produce, as PURE data (`bstShape` — no tracer/frames), nested.
  const program = TREE_PROGRAMS["bst-insert"] ?? Object.values(TREE_PROGRAMS)[0];
  if (!program) return undefined;
  const shape = bstShape(program.defaultInput);
  if (!shape.rootId) return undefined;
  return { kind: "tree", roots: [nestBst(shape, shape.rootId)] };
}
