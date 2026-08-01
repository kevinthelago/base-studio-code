// Outline diff (#4169, epic #3604) — compare the element tree the FILE copy of a page renders against the
// one its GRAPH node renders, and answer the question shadow mode exists to answer: is this page
// graph-identical, and if not, how far off is it?
//
// The comparison is a MULTISET difference over element PATHS (`Screen>TabBar>Chip`), not a tree-edit
// distance. A path carries nesting, so a moved element shows up; multiplicity carries repetition, so a
// dropped one of three `<Chip>`s shows up as one differing node rather than as "identical". Edit distance
// would give a prettier number and needs an alignment pass that has to guess which node matched which —
// this cannot be wrong about what it reports, only coarse.
import { outlinePaths, countNodes, type OutlineNode } from "./jsxOutline";

/** The structural verdict for ONE module (a page record or one of its tab-body siblings). */
export interface OutlineDiff {
  /** No structural difference at all — the graph node renders the same element tree as the file. */
  identical: boolean;
  /** Nodes present in one copy and not the other (counted with multiplicity) — the "N nodes differ". */
  differing: number;
  /** Total elements in the FILE copy, so `differing` reads against a denominator. */
  fileNodes: number;
  /** Total elements in the GRAPH copy. */
  graphNodes: number;
  /** Element paths the file renders and the graph node does not (capped — this is a signal, not a report). */
  onlyInFile: string[];
  /** Element paths the graph node renders and the file does not. */
  onlyInGraph: string[];
}

/** How many example paths each side reports. The count is the metric; the samples are for the worklist. */
const SAMPLE_CAP = 12;

/** Diff two element outlines. Order-independent within a parent (the paths are a multiset), so a
 *  reordering of siblings is NOT drift — only a changed shape is. */
export function diffOutlines(fileTree: OutlineNode[], graphTree: OutlineNode[]): OutlineDiff {
  const filePaths = outlinePaths(fileTree);
  const graphPaths = outlinePaths(graphTree);
  const onlyInFile = multisetMinus(filePaths, graphPaths);
  const onlyInGraph = multisetMinus(graphPaths, filePaths);
  const differing = onlyInFile.length + onlyInGraph.length;
  return {
    identical: differing === 0,
    differing,
    fileNodes: countNodes(fileTree),
    graphNodes: countNodes(graphTree),
    onlyInFile: onlyInFile.slice(0, SAMPLE_CAP),
    onlyInGraph: onlyInGraph.slice(0, SAMPLE_CAP),
  };
}

/** The entries of `a` not matched one-for-one by an entry of `b` (multiset difference, order preserved). */
function multisetMinus(a: string[], b: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const path of b) remaining.set(path, (remaining.get(path) ?? 0) + 1);
  const out: string[] = [];
  for (const path of a) {
    const left = remaining.get(path) ?? 0;
    if (left > 0) remaining.set(path, left - 1);
    else out.push(path);
  }
  return out;
}
