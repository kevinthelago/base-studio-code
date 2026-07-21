// #3220 — the tree programs. `TracedTree`, `<TreeView>` and `treeLayout.ts` shipped with the tracer work
// but no program was registered for the `tree` structure, so a tree could only be met inside a scene. These
// cover the BST pair that opens it — and the property that makes a BST worth building: the in-order walk
// comes out SORTED.
import { describe, it, expect } from "vitest";
import { runTreeAlgorithm, type TracedTree, type TreeNode } from "../../lib/tracer";
import type { TreeFrame } from "../../lib/trace";
import { bstShape, bstInsert, bstInorder, parseTreeInput, treeToText, TREE_PROGRAMS } from "./treeAlgos";

const VALUES = [50, 30, 70, 20, 40, 60, 80];
const last = <T>(xs: T[]): T => xs[xs.length - 1];

/** `runTreeAlgorithm` returns a FACTORY (replay-safe) — call it to get one run's frames. */
function framesOf(algo: (t: TracedTree) => void, seed: readonly TreeNode[] = []): TreeFrame[] {
  return [...runTreeAlgorithm(algo, seed)()] as TreeFrame[];
}

const opsWhere = (frames: TreeFrame[], op: string) =>
  frames.flatMap((f) => (f.ops ?? []).filter((o) => o.op === op));

describe("bstShape (#3220)", () => {
  it("puts smaller values left and larger right, rooted at the first insert", () => {
    const s = bstShape(VALUES);
    expect(s.rootId).toBe("n0");
    expect(s.nodes[0]).toEqual({ id: "n0", value: 50 });
    expect(s.left["n0"]).toBe("n1");  // 30
    expect(s.right["n0"]).toBe("n2"); // 70
    expect(s.left["n1"]).toBe("n3");  // 20
    expect(s.right["n1"]).toBe("n4"); // 40
  });

  it("records each non-root node's parent, so the tree can be laid out", () => {
    for (const n of bstShape(VALUES).nodes.slice(1)) expect(n.parent).toBeDefined();
  });

  it("drops duplicates — a BST holds a SET", () => {
    expect(bstShape([5, 3, 5, 3, 7]).nodes.map((n) => n.value)).toEqual([5, 3, 7]);
  });

  it("handles the degenerate sorted input (a right spine)", () => {
    const s = bstShape([1, 2, 3, 4]);
    expect(s.left["n0"]).toBeUndefined();
    expect(s.right["n0"]).toBe("n1");
    expect(s.right["n1"]).toBe("n2");
  });

  it("is empty for empty input", () => {
    expect(bstShape([]).rootId).toBeUndefined();
  });
});

describe("bstInsert (#3220)", () => {
  const frames = () => framesOf((t) => bstInsert(t, VALUES));

  it("builds the whole tree — one insert op per distinct value", () => {
    expect(opsWhere(frames(), "insert")).toHaveLength(VALUES.length);
  });

  it("starts from an EMPTY tree and ends holding every value", () => {
    const fs = frames();
    expect(fs[0].nodes).toEqual([]);
    expect(last(fs).nodes.map((n) => Number(n.value)).sort((a, b) => a - b))
      .toEqual([...VALUES].sort((a, b) => a - b));
  });

  it("never emits a compare — the value being placed has no node yet, so it could only compare with itself", () => {
    // Guards the honesty call in bstInsert's docstring: a decision frame that describes nothing is worse
    // than no frame. If a real compare becomes expressible, this test is the place to revisit it.
    expect(opsWhere(frames(), "compare")).toEqual([]);
  });

  it("leaves a path trail through the nodes the descent passed", () => {
    expect(frames().some((f) => Object.values(f.marks ?? {}).includes("path"))).toBe(true);
  });
});

describe("bstInorder (#3220)", () => {
  /** The visit sequence, in the order the traversal emitted it. */
  function visitOrder(values: number[]): number[] {
    const seed = bstShape(values).nodes;
    const byId = new Map(seed.map((n) => [n.id, Number(n.value)]));
    return opsWhere(framesOf((t) => bstInorder(t, values), seed), "visit")
      .map((o) => byId.get((o as { node: string }).node)!);
  }

  it("visits every node in SORTED order — the reason to build a BST", () => {
    expect(visitOrder(VALUES)).toEqual([...VALUES].sort((a, b) => a - b));
  });

  it("holds for an unbalanced tree (a right spine)", () => {
    expect(visitOrder([1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4, 5]);
  });

  it("holds for a reverse-sorted insert (a left spine)", () => {
    expect(visitOrder([5, 4, 3, 2, 1])).toEqual([1, 2, 3, 4, 5]);
  });

  it("starts from a FINISHED tree — the build is not replayed as part of the walk", () => {
    const seed = bstShape(VALUES).nodes;
    const fs = framesOf((t) => bstInorder(t, VALUES), seed);
    expect(fs[0].nodes).toHaveLength(VALUES.length);
    expect(opsWhere(fs, "insert")).toEqual([]);
  });

  it("emits nothing for an empty tree rather than throwing", () => {
    expect(() => framesOf((t) => bstInorder(t, []))).not.toThrow();
  });
});

describe("tree input parsing (#3220)", () => {
  it("accepts comma- or space-separated whole numbers", () => {
    expect(parseTreeInput("50, 30, 70")).toEqual([50, 30, 70]);
    expect(parseTreeInput("50 30 70")).toEqual([50, 30, 70]);
  });

  it.each([
    ["", /Enter numbers/],
    ["50, x", /not a number/],
    ["1.5", /whole numbers/],
    [Array.from({ length: 16 }, (_, i) => i).join(","), /15 values/],
  ])("rejects %s with a helpful message", (text, msg) => {
    expect(() => parseTreeInput(text)).toThrow(msg);
  });

  it("round-trips each shipped default through its text form", () => {
    for (const program of Object.values(TREE_PROGRAMS)) {
      expect(parseTreeInput(treeToText(program.defaultInput))).toEqual(program.defaultInput);
    }
  });
});

describe("TREE_PROGRAMS (#3220)", () => {
  it("every shipped program produces a non-trivial tree trace", () => {
    for (const [key, program] of Object.entries(TREE_PROGRAMS)) {
      const fs = framesOf((t) => program.run(t, program.defaultInput), program.seed(program.defaultInput));
      expect(fs.length, key).toBeGreaterThan(2);
      expect(fs.every((f) => f.structure === "tree"), key).toBe(true);
    }
  });

  it("insert starts empty and in-order starts seeded — the pair's whole distinction", () => {
    expect(TREE_PROGRAMS["bst-insert"].seed(VALUES)).toEqual([]);
    expect(TREE_PROGRAMS["bst-inorder"].seed(VALUES)).toHaveLength(VALUES.length);
  });
});
