// The Algorithms knowledge-graph model (#2761): seed integrity, the column-by-kind layout, the
// neighbor/relation lookups, and BFS pathfinding.
import { describe, it, expect } from "vitest";
import {
  KNOWLEDGE, KIND_ORDER, TECHS, TECH_META, layoutKnowledge, layoutKitGraph, neighborsOf, relationsOf, pathBetween,
  nodeIndex, edgeId, implsForConcept, implFor, implById, techsWithImpl, usedByImpl,
  kitTechs, kitImpls, kitImplsByRole, kitGraph, groupImplsByLanguage,
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
    const rs = implFor(KNOWLEDGE, "merge-sort", "rust");
    expect(rs?.id).toBe("merge-sort.rs");
    // The flagship "builds on" edge — merge-sort.rs composes merge.rs and roots in the Rust primitives.
    expect(rs?.composes).toEqual(["merge.rs", "rust.vec", "rust.slice"]);
    // The seed is Rust-only (#2760): no TypeScript implementation exists.
    expect(implFor(KNOWLEDGE, "merge-sort", "typescript")).toBeUndefined();

    // A node with no implementation in any tier returns undefined / empty.
    expect(implFor(KNOWLEDGE, "array", "rust")).toBeUndefined();
    expect(implsForConcept(KNOWLEDGE, "array")).toEqual([]);

    expect(implsForConcept(KNOWLEDGE, "merge-sort").map((i) => i.tech)).toEqual(["rust"]);
    expect(techsWithImpl(KNOWLEDGE, "merge-sort")).toEqual(["rust"]);
    expect(techsWithImpl(KNOWLEDGE, "array")).toEqual([]);
  });

  it("implById resolves an id and misses cleanly", () => {
    expect(implById(KNOWLEDGE, "bfs.rs")?.tech).toBe("rust");
    expect(implById(KNOWLEDGE, "nope.rs")).toBeUndefined();
  });

  it("usedByImpl is the reverse of composes", () => {
    expect(usedByImpl(KNOWLEDGE, "merge.rs").map((i) => i.id)).toEqual(["merge-sort.rs"]);
    // A top-level impl no one composes has no reverse edges.
    expect(usedByImpl(KNOWLEDGE, "merge-sort.rs")).toEqual([]);
  });

  it("seed integrity: unique ids, real concept targets, canonical id, same-tech composes", () => {
    const nodeIds = new Set(KNOWLEDGE.nodes.map((n) => n.id));
    const implIds = new Set(KNOWLEDGE.implementations.map((i) => i.id));
    expect(implIds.size).toBe(KNOWLEDGE.implementations.length); // ids are unique
    expect(KNOWLEDGE.implementations.length).toBeGreaterThanOrEqual(16);
    for (const im of KNOWLEDGE.implementations) {
      expect(["primitive", "algorithm"]).toContain(im.role); // #2863 language-kit tier
      expect(TECHS).toContain(im.tech);
      expect(im.code.trim().length).toBeGreaterThan(0);
      // A concept-bearing impl targets a REAL node + follows the id convention; a free-standing
      // primitive (#2863, e.g. `rust.iterator`) has no concept and its own id.
      if (im.concept) {
        expect(nodeIds.has(im.concept)).toBe(true);
        expect(im.id).toBe(`${im.concept}.${TECH_META[im.tech].ext}`);
      }
      for (const c of im.composes) {
        expect(implIds.has(c)).toBe(true); // every composes id is a REAL impl id
        expect(implById(KNOWLEDGE, c)!.tech).toBe(im.tech); // and of the SAME tech
      }
    }
  });

  it("every algorithm-kind concept carries a Rust fundamental (#2760 — Rust-only seed)", () => {
    const algos = KNOWLEDGE.nodes.filter((n) => n.kind === "algorithm");
    // The seeded fundamentals: 16 algorithm nodes, each with one real Rust implementation.
    expect(algos.length).toBe(16);
    for (const node of algos) {
      const rs = implFor(KNOWLEDGE, node.id, "rust");
      expect(rs, `${node.id} is missing its Rust fundamental`).toBeDefined();
      // The seed is Rust-only — no TypeScript fundamentals remain.
      expect(implFor(KNOWLEDGE, node.id, "typescript")).toBeUndefined();
      // Each fundamental's `composes` ids resolve to REAL impls of the SAME tech.
      for (const c of rs!.composes) {
        const dep = implById(KNOWLEDGE, c);
        expect(dep, `${rs!.id} composes a missing impl ${c}`).toBeDefined();
        expect(dep!.tech).toBe("rust");
      }
    }
    // No concept-bearing implementation targets a non-algorithm node (free-standing primitives (#2863)
    // have no concept and are skipped).
    const byId = nodeIndex(KNOWLEDGE.nodes);
    for (const im of KNOWLEDGE.implementations) {
      if (im.concept) expect(byId.get(im.concept)?.kind).toBe("algorithm");
    }
  });
});

describe("language kits (#2863) — a kit is every impl of one tech, grouped by role", () => {
  it("kitTechs lists the seeded languages, TECHS-ordered", () => {
    expect(kitTechs(KNOWLEDGE)).toEqual(["rust"]); // Rust-only seed (#2760)
  });

  it("kitImpls scopes to one language; kitImplsByRole splits primitives from algorithms", () => {
    const rs = kitImpls(KNOWLEDGE, "rust");
    expect(rs.length).toBeGreaterThan(0);
    expect(rs.every((im) => im.tech === "rust")).toBe(true);
    const prims = kitImplsByRole(KNOWLEDGE, "rust", "primitive");
    const algos = kitImplsByRole(KNOWLEDGE, "rust", "algorithm");
    // `primitive` is now a LANGUAGE built-in (#2958); every user-written impl is an `algorithm`.
    expect(prims.map((im) => im.id)).toContain("rust.iterator"); // a language primitive
    expect(prims.map((im) => im.id)).toContain("rust.vec"); // a language primitive
    expect(algos.map((im) => im.id)).toContain("merge.rs"); // a user impl (no longer a "primitive")
    expect(algos.map((im) => im.id)).toContain("merge-sort.rs"); // an algorithm
    expect(prims.length + algos.length).toBe(rs.length);
  });

  it("a language primitive is composed UP by its algorithms (usedByImpl, #2958)", () => {
    const iterator = implById(KNOWLEDGE, "rust.iterator")!;
    expect(iterator.role).toBe("primitive");
    expect(iterator.concept).toBeUndefined(); // free-standing — the impl IS the concept
    // Algorithms COMPOSE the primitive (composition points down to the base); the reverse is
    // `usedByImpl`. quick-sort.rs builds on the Iterator primitive.
    const users = usedByImpl(KNOWLEDGE, "rust.iterator").map((im) => im.id);
    expect(users).toContain("quick-sort.rs");
    expect(users.every((id) => id.endsWith(".rs"))).toBe(true); // same-tech
  });

  it("groupImplsByLanguage makes one folder per language, primitives before algorithms (the rail tree)", () => {
    const groups = groupImplsByLanguage(KNOWLEDGE);
    // One folder per language kit, in kitTechs order.
    expect(groups.map((g) => g.tech)).toEqual(kitTechs(KNOWLEDGE));
    const rs = groups.find((g) => g.tech === "rust")!;
    expect(rs.label).toBe("Rust");
    expect(rs.key).toBe("lang:rust");
    expect(rs.dot).toBe("var(--state-wait)"); // the per-language folder-head color (#2902)
    // Every impl in the folder is that language's, and every primitive precedes every algorithm.
    expect(rs.impls.every((im) => im.tech === "rust")).toBe(true);
    const firstAlgo = rs.impls.findIndex((im) => im.role === "algorithm");
    const lastPrim = rs.impls.map((im) => im.role).lastIndexOf("primitive");
    expect(lastPrim).toBeLessThan(firstAlgo);
    expect(rs.impls.map((im) => im.id)).toContain("rust.iterator"); // a primitive
    expect(rs.impls.map((im) => im.id)).toContain("merge-sort.rs"); // an algorithm
  });

  it("kitGraph builds a kit's own impl graph — nodes are that tech's impls, wired by composes", () => {
    const kg = kitGraph(KNOWLEDGE, "rust");
    // Nodes are exactly the Rust kit's impls.
    expect(kg.nodes).toEqual(kitImpls(KNOWLEDGE, "rust"));
    expect(kg.nodes.every((n) => n.tech === "rust")).toBe(true);
    // The builds-on edge (merge-sort.rs composes merge.rs) is present as a `composes` edge…
    expect(kg.edges).toContainEqual({ from: "merge-sort.rs", to: "merge.rs", rel: "composes" });
    // …and an algorithm rooting in a language primitive (quick-sort.rs composes rust.iterator) too.
    expect(kg.edges).toContainEqual({ from: "quick-sort.rs", to: "rust.iterator", rel: "composes" });
    // Every edge endpoint is an in-kit impl id (never a concept id or a cross-tech impl).
    const ids = new Set(kg.nodes.map((n) => n.id));
    expect(kg.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
  });

  it("kitGraph lifts the ontology's non-composes relationships onto the concrete impls", () => {
    const kg = kitGraph(KNOWLEDGE, "rust");
    const implOf = (concept: string) => implFor(KNOWLEDGE, concept, "rust")?.id;
    // Find an ontology edge whose rel isn't `composes` and whose BOTH endpoints have a TS impl…
    const lift = KNOWLEDGE.edges.find((e) => e.rel !== "composes" && implOf(e.from) && implOf(e.to) && implOf(e.from) !== implOf(e.to));
    if (lift) {
      // …it must appear as an impl-level edge with the same rel.
      expect(kg.edges).toContainEqual({ from: implOf(lift.from)!, to: implOf(lift.to)!, rel: lift.rel });
    }
    // No lifted edge is a `composes` (those live only at the impl level).
    const composeCount = kg.edges.filter((e) => e.rel === "composes").length;
    expect(composeCount).toBe(kg.nodes.reduce((acc, n) => acc + n.composes.filter((c) => kg.nodes.some((m) => m.id === c)).length, 0));
  });

  it("layoutKitGraph columns primitives at the base and algorithms deepening right (compose depth)", () => {
    const kg = kitGraph(KNOWLEDGE, "rust");
    const l = layoutKitGraph(kg);
    expect([...l.pos.keys()].sort()).toEqual(kg.nodes.map((n) => n.id).sort());
    const x = (id: string) => l.pos.get(id)!.x;
    // A primitive (merge.rs) sits strictly left of the algorithm that composes it (merge-sort.rs).
    expect(x("merge.rs")).toBeLessThan(x("merge-sort.rs"));
    expect(l.world.w).toBeGreaterThan(0);
    expect(l.world.h).toBeGreaterThan(0);
  });
});
