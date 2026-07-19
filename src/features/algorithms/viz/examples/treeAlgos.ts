// TREE trace-programs (#3220, epic #3215) — the binary-search-tree pair, written over a TracedTree so the
// animation is DERIVED from the real walk: every `compare` frame IS the comparison that chose a branch.
//
// WHY THESE EXIST: same story as the stack programs. `TracedTree`, `<TreeView>`, `treeLayout.ts` and their
// tests all shipped, but no program was ever registered for the `tree` structure — so a tree could only be
// met inside a scene, never selected. These two open it, and they are a matched pair on purpose: BUILD the
// structure (insert, which is where the compares live) then READ it (in-order, which is what makes a BST
// worth building — the sorted walk).
import type { TracedTree, TreeNode } from "../../lib/tracer";

/** A visualizable tree algorithm — its logic over a {@link TracedTree}, plus the nodes the tree STARTS with.
 *  `seed` is what separates the pair: insert starts from nothing and builds; in-order starts from a finished
 *  tree and walks it, so the build noise is not replayed as part of the traversal. */
export interface TreeProgram {
  run: (t: TracedTree, values: number[]) => void;
  /** The tree at rest before `run` — `[]` when the algorithm builds it itself. */
  seed: (values: number[]) => TreeNode[];
  defaultInput: number[];
}

/** A BST laid out as ids + child links. Ids are `n<i>` by INSERTION order, so a node's id is stable across
 *  both programs and the two animations are talking about the same tree. */
export interface BstShape {
  nodes: TreeNode[];
  left: Record<string, string | undefined>;
  right: Record<string, string | undefined>;
  rootId: string | undefined;
}

/**
 * Build the BST that `values` produces, as pure data — no tracer, no frames.
 *
 * Both programs need to know the tree's shape: insert walks it to find each landing spot, and in-order
 * needs the child links the tracer does not model (a {@link TreeNode} carries only a `parent`, which is
 * enough to LAY OUT a tree but not enough to walk one in order). Deriving the shape here once keeps the two
 * programs consistent by construction. Duplicates are dropped — a BST holds a set.
 */
export function bstShape(values: readonly number[]): BstShape {
  const nodes: TreeNode[] = [];
  const left: Record<string, string | undefined> = {};
  const right: Record<string, string | undefined> = {};
  const valueOf: Record<string, number> = {};
  let rootId: string | undefined;

  for (const v of values) {
    const id = `n${nodes.length}`;
    if (rootId === undefined) {
      rootId = id;
      nodes.push({ id, value: v });
      valueOf[id] = v;
      continue;
    }
    let cur = rootId;
    for (;;) {
      if (v === valueOf[cur]) break; // already present — a BST holds a set
      const goLeft = v < valueOf[cur];
      const next = goLeft ? left[cur] : right[cur];
      if (next === undefined) {
        if (goLeft) left[cur] = id;
        else right[cur] = id;
        nodes.push({ id, value: v, parent: cur });
        valueOf[id] = v;
        break;
      }
      cur = next;
    }
  }
  return { nodes, left, right, rootId };
}

/**
 * Insert each value into a BST, starting from an empty tree — the build half of the pair.
 *
 * The descent is the animation: each node the walk passes through takes a `path` mark, and the value lands
 * with an `insert` frame under the parent that trail chose.
 *
 * `compare` is deliberately NOT used. The tracer compares two EXISTING nodes by id, and the value being
 * placed has no node until it lands — so the only compare available during a descent is a node against
 * itself, which would render a decision frame that describes nothing. The path marks are the real trail;
 * an honest empty frame beats a decorative one.
 */
export function bstInsert(t: TracedTree, values: number[]): void {
  const shape = bstShape(values);
  const valueOf = new Map(shape.nodes.map((n) => [n.id, n.value as number]));
  for (const node of shape.nodes) {
    const v = node.value as number;
    if (node.parent === undefined) {
      t.insert(node.id, v); // the root names itself
      continue;
    }
    let cur = shape.rootId!;
    for (;;) {
      t.mark(cur, "path");
      if (cur === node.parent) break;
      const next = v < valueOf.get(cur)! ? shape.left[cur] : shape.right[cur];
      if (next === undefined) break;
      cur = next;
    }
    t.insert(node.id, v, node.parent);
    t.mark(node.id, "current");
  }
}

/**
 * Walk a finished BST in order (left · node · right) — the read half of the pair, and the reason a BST is
 * worth building: the visit sequence comes out SORTED.
 *
 * Iterative with an explicit stack rather than recursion, so the traversal's own pending set is a real data
 * structure the frames can reflect, and a deep tree cannot blow the JS stack.
 */
export function bstInorder(t: TracedTree, values: number[]): void {
  const shape = bstShape(values);
  const stack: string[] = [];
  let cur = shape.rootId;
  while (cur !== undefined || stack.length > 0) {
    while (cur !== undefined) {
      t.mark(cur, "path"); // descending the left spine
      stack.push(cur);
      cur = shape.left[cur];
    }
    const id = stack.pop()!;
    t.visit(id); // the in-order position — these fire in sorted order
    cur = shape.right[id];
  }
}

/** The default seed — an unbalanced-but-readable BST: root 50, both subtrees populated, 9 nodes. */
const TREE_MOCK = [50, 30, 70, 20, 40, 60, 80, 35, 65];

/** The visualizable tree algorithms, keyed by base name (#3220). */
export const TREE_PROGRAMS: Record<string, TreeProgram> = {
  "bst-insert": { run: bstInsert, seed: () => [], defaultInput: TREE_MOCK },
  "bst-inorder": { run: bstInorder, seed: (values) => bstShape(values).nodes, defaultInput: TREE_MOCK },
};

/** Serialize a tree seed to the "your input" text form — the insertion order, comma-separated. */
export function treeToText(input: readonly number[]): string {
  return input.join(", ");
}

/**
 * Parse the "your input" text into an insertion order — comma- or space-separated whole numbers. Throws a
 * helpful `Error` (shown under the field) on empty, non-numeric, or unwatchably-large input.
 */
export function parseTreeInput(text: string): number[] {
  const t = text.trim();
  if (t.length === 0) throw new Error("Enter numbers to insert, e.g. 50, 30, 70");
  const parts = t.split(/[\s,]+/).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) throw new Error(`"${p}" is not a number`);
    if (!Number.isInteger(n)) throw new Error("Use whole numbers so the nodes stay readable");
    out.push(n);
  }
  if (out.length > 15) throw new Error("Keep it to 15 values so the tree stays on screen");
  return out;
}
