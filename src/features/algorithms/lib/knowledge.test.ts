// The Algorithms knowledge-graph model (#2761): seed integrity, the column-by-kind layout, the
// neighbor/relation lookups, and BFS pathfinding.
import { describe, it, expect } from "vitest";
import {
  KNOWLEDGE, KIND_ORDER, TECHS, TECH_META, layoutKnowledge, neighborsOf, relationsOf, pathBetween,
  nodeIndex, edgeId, implsForConcept, implFor, implById, techsWithImpl, usedByImpl,
} from "./knowledge";

describe("KNOWLEDGE seed", () => {
  it("loads nodes + edges, every node stamped provenance:seed with a valid kind", () => {
    expect(KNOWLEDGE.nodes.length).toBeGreaterThan(30);
    expect(KNOWLEDGE.edges.length).toBeGreaterThan(30);
    for (const n of KNOWLEDGE.nodes) {
      expect(KIND_ORDER).toContain(n.kind);
      expect(n.provenance).toBe("seed");
      expect(n.name.trim().length).toBeGreaterThan(0);
    }
  });

  it("has unique node ids and every edge references existing nodes (referential integrity)", () => {
    const ids = KNOWLEDGE.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    const has = nodeIndex(KNOWLEDGE.nodes);
    for (const e of KNOWLEDGE.edges) {
      expect(has.has(e.from)).toBe(true);
      expect(has.has(e.to)).toBe(true);
    }
  });

  it("leaves no orphan nodes — every concept participates in at least one relationship", () => {
    const touched = new Set<string>();
    for (const e of KNOWLEDGE.edges) { touched.add(e.from); touched.add(e.to); }
    const orphans = KNOWLEDGE.nodes.filter((n) => !touched.has(n.id)).map((n) => n.id);
    expect(orphans).toEqual([]);
  });

  it("gives each (from,rel,to) a distinct edge id", () => {
    const ids = KNOWLEDGE.edges.map(edgeId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("layoutKnowledge", () => {
  it("positions every node and columns strictly left→right by kind", () => {
    const { pos, world, bounds } = layoutKnowledge(KNOWLEDGE.nodes);
    expect(pos.size).toBe(KNOWLEDGE.nodes.length);
    expect(world.w).toBeGreaterThan(0);
    expect(world.h).toBeGreaterThan(0);
    expect(bounds.w).toBeGreaterThan(0);
    // The x of each kind's column increases in KIND_ORDER; all nodes of a kind share one x.
    const xOf = (kind: string) => {
      const xs = new Set(KNOWLEDGE.nodes.filter((n) => n.kind === kind).map((n) => pos.get(n.id)!.x));
      expect(xs.size).toBe(1); // one column per kind
      return [...xs][0];
    };
    const xs = KIND_ORDER.map(xOf);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
  });
});

describe("neighborsOf / relationsOf", () => {
  it("lights merge-sort with itself, its neighbors, and its incident edges", () => {
    const { nodes, edges } = neighborsOf(KNOWLEDGE, "merge-sort");
    expect(nodes.has("merge-sort")).toBe(true);
    for (const id of ["merge", "divide-and-conquer", "array", "comparison-sort", "sorted-sequence"]) {
      expect(nodes.has(id)).toBe(true);
    }
    expect(edges.size).toBeGreaterThanOrEqual(5);
  });

  it("relationsOf reports direction and the other endpoint", () => {
    const rels = relationsOf(KNOWLEDGE, "merge-sort");
    const operatesOnArray = rels.find((r) => r.other.id === "array");
    expect(operatesOnArray?.edge.rel).toBe("operates-on");
    expect(operatesOnArray?.dir).toBe("out"); // merge-sort → array
  });
});

describe("pathBetween (undirected BFS)", () => {
  it("finds the fractal thread fibonacci → mandelbrot", () => {
    const path = pathBetween(KNOWLEDGE, "fibonacci", "mandelbrot");
    expect(path?.[0]).toBe("fibonacci");
    expect(path?.[path.length - 1]).toBe("mandelbrot");
    // Two equal-length shortest paths exist (fibonacci→golden-ratio→… and fibonacci→recursion→…,
    // and BFS picks recursion since composes-edges sort first) — so pin the INVARIANT hops, not the
    // ambiguous middle: length 4, and self-similarity is always the penultimate node (mandelbrot's
    // only link).
    expect(path).toHaveLength(4);
    expect(path?.[2]).toBe("self-similarity");
  });

  it("returns [id] for a node to itself and null for an unknown id", () => {
    expect(pathBetween(KNOWLEDGE, "heap", "heap")).toEqual(["heap"]);
    expect(pathBetween(KNOWLEDGE, "heap", "nope")).toBeNull();
  });
});

describe("implementation tier (#2770)", () => {
  it("implFor / implsForConcept / techsWithImpl resolve per-tech implementations", () => {
    const ts = implFor(KNOWLEDGE, "merge-sort", "typescript");
    expect(ts?.id).toBe("merge-sort.ts");
    // The flagship "builds on" edge — merge-sort.ts composes the merge.ts primitive.
    expect(ts?.composes).toEqual(["merge.ts"]);
    expect(implFor(KNOWLEDGE, "merge-sort", "rust")?.composes).toEqual(["merge.rs"]);

    // A node with no implementation in a tier returns undefined / empty.
    expect(implFor(KNOWLEDGE, "array", "typescript")).toBeUndefined();
    expect(implsForConcept(KNOWLEDGE, "array")).toEqual([]);

    expect(implsForConcept(KNOWLEDGE, "merge-sort").map((i) => i.tech).sort()).toEqual(["rust", "typescript"]);
    expect(techsWithImpl(KNOWLEDGE, "merge-sort")).toEqual(["typescript", "rust"]); // in TECHS order
    expect(techsWithImpl(KNOWLEDGE, "array")).toEqual([]);
  });

  it("implById resolves an id and misses cleanly", () => {
    expect(implById(KNOWLEDGE, "bfs.rs")?.tech).toBe("rust");
    expect(implById(KNOWLEDGE, "nope.ts")).toBeUndefined();
  });

  it("usedByImpl is the reverse of composes", () => {
    expect(usedByImpl(KNOWLEDGE, "merge.ts").map((i) => i.id)).toEqual(["merge-sort.ts"]);
    expect(usedByImpl(KNOWLEDGE, "merge.rs").map((i) => i.id)).toEqual(["merge-sort.rs"]);
    // A top-level impl no one composes has no reverse edges.
    expect(usedByImpl(KNOWLEDGE, "merge-sort.ts")).toEqual([]);
  });

  it("seed integrity: unique ids, real concept targets, canonical id, same-tech composes", () => {
    const nodeIds = new Set(KNOWLEDGE.nodes.map((n) => n.id));
    const implIds = new Set(KNOWLEDGE.implementations.map((i) => i.id));
    expect(implIds.size).toBe(KNOWLEDGE.implementations.length); // ids are unique
    expect(KNOWLEDGE.implementations.length).toBe(32);
    for (const im of KNOWLEDGE.implementations) {
      expect(nodeIds.has(im.concept)).toBe(true); // every impl targets a REAL node id
      expect(TECHS).toContain(im.tech);
      expect(im.id).toBe(`${im.concept}.${TECH_META[im.tech].ext}`); // id = <concept>.<ext>
      expect(im.code.trim().length).toBeGreaterThan(0);
      for (const c of im.composes) {
        expect(implIds.has(c)).toBe(true); // every composes id is a REAL impl id
        expect(implById(KNOWLEDGE, c)!.tech).toBe(im.tech); // and of the SAME tech
      }
    }
  });

  it("every algorithm-kind concept carries BOTH a TypeScript and a Rust fundamental (#2783)", () => {
    const algos = KNOWLEDGE.nodes.filter((n) => n.kind === "algorithm");
    // The seeded fundamentals: 16 algorithm nodes × 2 techs = 32 implementations.
    expect(algos.length).toBe(16);
    for (const node of algos) {
      const ts = implFor(KNOWLEDGE, node.id, "typescript");
      const rs = implFor(KNOWLEDGE, node.id, "rust");
      expect(ts, `${node.id} is missing its TypeScript fundamental`).toBeDefined();
      expect(rs, `${node.id} is missing its Rust fundamental`).toBeDefined();
      // Each fundamental's `composes` ids resolve to REAL impls of the SAME tech.
      for (const c of ts!.composes) {
        const dep = implById(KNOWLEDGE, c);
        expect(dep, `${ts!.id} composes a missing impl ${c}`).toBeDefined();
        expect(dep!.tech).toBe("typescript");
      }
      for (const c of rs!.composes) {
        const dep = implById(KNOWLEDGE, c);
        expect(dep, `${rs!.id} composes a missing impl ${c}`).toBeDefined();
        expect(dep!.tech).toBe("rust");
      }
    }
    // No orphan implementation targets a non-algorithm node.
    for (const im of KNOWLEDGE.implementations) {
      expect(nodeIndex(KNOWLEDGE.nodes).get(im.concept)?.kind).toBe("algorithm");
    }
  });
});
