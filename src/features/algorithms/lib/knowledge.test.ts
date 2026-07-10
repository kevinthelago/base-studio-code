// The Algorithms knowledge-graph model (#2761): seed integrity, the column-by-kind layout, the
// neighbor/relation lookups, and BFS pathfinding.
import { describe, it, expect } from "vitest";
import {
  KNOWLEDGE, KIND_ORDER, layoutKnowledge, neighborsOf, relationsOf, pathBetween, nodeIndex, edgeId,
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
    // fibonacci ~ golden-ratio ~ self-similarity ~ mandelbrot (shortest is 4 nodes).
    expect(path).toEqual(["fibonacci", "golden-ratio", "self-similarity", "mandelbrot"]);
  });

  it("returns [id] for a node to itself and null for an unknown id", () => {
    expect(pathBetween(KNOWLEDGE, "heap", "heap")).toEqual(["heap"]);
    expect(pathBetween(KNOWLEDGE, "heap", "nope")).toBeNull();
  });
});
