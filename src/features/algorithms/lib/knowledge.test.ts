// The Algorithms knowledge-graph model (#2761/#2958): the impl-only, primitives-rooted model — seed
// integrity, the per-language kits, the composes graph, and the compose-depth layout. The abstract
// concept ontology (nodes/edges) was removed with #2961 — a node IS its implementation.
import { describe, it, expect } from "vitest";
import {
  KNOWLEDGE, TECHS, implById, usedByImpl,
  kitTechs, kitImpls, kitImplsByRole, kitGraph, groupImplsByLanguage, layoutKitGraph,
  buildKnowledge, domainsOf, implsByDomain, kitImplsByDomain, type AlgoImpl,
} from "./knowledge";

describe("KNOWLEDGE seed (impl-only, #2958)", () => {
  it("carries the Rust kit — unique ids, known roles, real same-tech composes", () => {
    const impls = KNOWLEDGE.implementations;
    expect(impls.length).toBeGreaterThanOrEqual(16);
    const ids = new Set(impls.map((i) => i.id));
    expect(ids.size).toBe(impls.length); // ids unique
    for (const im of impls) {
      expect(["primitive", "algorithm"]).toContain(im.role);
      expect(TECHS).toContain(im.tech);
      expect(im.name.trim().length).toBeGreaterThan(0);
      // #2972: an algorithm carries real, reusable code; a primitive is a DESCRIPTOR of a language
      // built-in — it names its std `ref` and is NOT re-coded.
      if (im.role === "algorithm") {
        expect((im.code ?? "").trim().length).toBeGreaterThan(0);
      } else {
        expect((im.ref ?? "").trim().length).toBeGreaterThan(0);
        expect(im.code).toBeUndefined();
      }
      for (const c of im.composes) {
        expect(ids.has(c)).toBe(true); // every composes id is a REAL impl
        expect(implById(KNOWLEDGE, c)!.tech).toBe(im.tech); // and of the SAME tech
      }
    }
  });

  it("is primitives-rooted — every kit has a primitive base and algorithms that compose down to it", () => {
    for (const tech of kitTechs(KNOWLEDGE)) {
      const prims = kitImplsByRole(KNOWLEDGE, tech, "primitive");
      const algos = kitImplsByRole(KNOWLEDGE, tech, "algorithm");
      expect(prims.length).toBeGreaterThan(0); // a base exists
      // At least one algorithm composes a primitive (roots in the base).
      expect(algos.some((a) => a.composes.some((c) => prims.some((p) => p.id === c)))).toBe(true);
    }
  });
});

describe("implById / usedByImpl", () => {
  it("implById resolves an id and misses cleanly", () => {
    expect(implById(KNOWLEDGE, "bfs.rs")?.tech).toBe("rust");
    expect(implById(KNOWLEDGE, "nope.rs")).toBeUndefined();
  });

  it("merge-sort.rs composes merge.rs and roots in the Rust primitives", () => {
    const ms = implById(KNOWLEDGE, "merge-sort.rs");
    expect(ms?.composes).toEqual(["merge.rs", "rust.vec", "rust.slice"]);
  });

  it("usedByImpl is the reverse of composes", () => {
    // merge.rs is composed only by merge-sort.rs.
    expect(usedByImpl(KNOWLEDGE, "merge.rs").map((i) => i.id)).toEqual(["merge-sort.rs"]);
    // A top-level algorithm no one composes has no reverse edges.
    expect(usedByImpl(KNOWLEDGE, "merge-sort.rs")).toEqual([]);
    // A language primitive is composed UP by its algorithms.
    expect(usedByImpl(KNOWLEDGE, "rust.iterator").map((i) => i.id)).toContain("quick-sort.rs");
  });
});

describe("language kits (#2863) — a kit is every impl of one tech, grouped by role", () => {
  it("kitTechs lists the seeded languages, TECHS-ordered", () => {
    expect(kitTechs(KNOWLEDGE)).toEqual(["rust"]); // Rust-only seed (#2760)
  });

  it("kitImpls scopes to one language; kitImplsByRole splits primitives (language built-ins) from algorithms", () => {
    const rs = kitImpls(KNOWLEDGE, "rust");
    expect(rs.length).toBeGreaterThan(0);
    expect(rs.every((im) => im.tech === "rust")).toBe(true);
    const prims = kitImplsByRole(KNOWLEDGE, "rust", "primitive");
    const algos = kitImplsByRole(KNOWLEDGE, "rust", "algorithm");
    expect(prims.map((im) => im.id)).toContain("rust.iterator"); // a language primitive
    expect(prims.map((im) => im.id)).toContain("rust.vec"); // a language primitive
    expect(algos.map((im) => im.id)).toContain("merge.rs"); // a user impl
    expect(algos.map((im) => im.id)).toContain("merge-sort.rs"); // an algorithm
    expect(prims.length + algos.length).toBe(rs.length);
  });

  it("groupImplsByLanguage makes one folder per language, primitives before algorithms (the rail tree)", () => {
    const groups = groupImplsByLanguage(KNOWLEDGE);
    expect(groups.map((g) => g.tech)).toEqual(kitTechs(KNOWLEDGE));
    const rs = groups.find((g) => g.tech === "rust")!;
    expect(rs.label).toBe("Rust");
    expect(rs.key).toBe("lang:rust");
    expect(rs.dot).toBe("var(--state-wait)"); // the per-language folder-head color (#2902)
    expect(rs.impls.every((im) => im.tech === "rust")).toBe(true);
    const firstAlgo = rs.impls.findIndex((im) => im.role === "algorithm");
    const lastPrim = rs.impls.map((im) => im.role).lastIndexOf("primitive");
    expect(lastPrim).toBeLessThan(firstAlgo);
    expect(rs.impls.map((im) => im.id)).toContain("rust.iterator"); // a primitive
    expect(rs.impls.map((im) => im.id)).toContain("merge-sort.rs"); // an algorithm
  });

  it("kitGraph builds a kit's own impl graph — nodes are that tech's impls, wired by composes only", () => {
    const kg = kitGraph(KNOWLEDGE, "rust");
    expect(kg.nodes).toEqual(kitImpls(KNOWLEDGE, "rust"));
    expect(kg.nodes.every((n) => n.tech === "rust")).toBe(true);
    // The builds-on edge (merge-sort.rs composes merge.rs)…
    expect(kg.edges).toContainEqual({ from: "merge-sort.rs", to: "merge.rs", rel: "composes" });
    // …and an algorithm rooting in a language primitive (quick-sort.rs composes rust.iterator).
    expect(kg.edges).toContainEqual({ from: "quick-sort.rs", to: "rust.iterator", rel: "composes" });
    // Every edge is a `composes` between in-kit impl ids (the ontology is gone, #2961).
    const ids = new Set(kg.nodes.map((n) => n.id));
    expect(kg.edges.every((e) => e.rel === "composes" && ids.has(e.from) && ids.has(e.to))).toBe(true);
    // The composes edge count equals the sum of in-kit composes references.
    const composeRefs = kg.nodes.reduce((acc, n) => acc + n.composes.filter((c) => ids.has(c)).length, 0);
    expect(kg.edges.length).toBe(composeRefs);
  });

  it("layoutKitGraph columns primitives at the base and algorithms deepening right (compose depth)", () => {
    const kg = kitGraph(KNOWLEDGE, "rust");
    const l = layoutKitGraph(kg);
    expect([...l.pos.keys()].sort()).toEqual(kg.nodes.map((n) => n.id).sort());
    const x = (id: string) => l.pos.get(id)!.x;
    // A primitive (rust.vec, depth 0) sits left of merge.rs (composes it, depth 1), which sits left of
    // merge-sort.rs (composes merge.rs, depth 2) — depth increases as it grows up from the base.
    expect(x("rust.vec")).toBeLessThan(x("merge.rs"));
    expect(x("merge.rs")).toBeLessThan(x("merge-sort.rs"));
    expect(l.world.w).toBeGreaterThan(0);
    expect(l.world.h).toBeGreaterThan(0);
  });
});

describe("domain facet (#3120) — a lightweight, cross-language collection tag", () => {
  // A synthetic library with a domain facet across two languages, plus one untagged impl.
  const im = (o: Partial<AlgoImpl> & Pick<AlgoImpl, "id" | "tech">): AlgoImpl =>
    ({ role: "algorithm", name: o.id, composes: [], ...o });
  const g = buildKnowledge({
    implementations: [
      im({ id: "dijkstra.rs", tech: "rust", domain: "logistics" }),
      im({ id: "a-star.rs", tech: "rust", domain: "logistics" }),
      im({ id: "route.ts", tech: "typescript", domain: "logistics" }),
      im({ id: "blur.ts", tech: "typescript", domain: "graphics" }),
      im({ id: "plain.rs", tech: "rust" }), // no domain — absent from every collection
    ],
  });

  it("existing impls without a domain load — the facet is absent, not defaulted (backward compatible)", () => {
    const ms = implById(KNOWLEDGE, "merge-sort.rs")!;
    expect(ms.domain).toBeUndefined();
    expect(ms.tags).toBeUndefined();
    // The Rust-only seed carries no domain facet at all — so the rail hides the domain affordance.
    expect(domainsOf(KNOWLEDGE)).toEqual([]);
  });

  it("domainsOf lists the distinct domains present, stable-sorted, ignoring untagged impls", () => {
    expect(domainsOf(g)).toEqual(["graphics", "logistics"]);
  });

  it("implsByDomain pulls a domain's impls ACROSS languages (the cross-cutting collection)", () => {
    expect(implsByDomain(g, "logistics").map((i) => i.id)).toEqual(["dijkstra.rs", "a-star.rs", "route.ts"]);
    expect(implsByDomain(g, "graphics").map((i) => i.id)).toEqual(["blur.ts"]);
    // A blank/unknown domain is an empty collection (never the untagged impls).
    expect(implsByDomain(g, "nope")).toEqual([]);
    expect(implsByDomain(g, "  ")).toEqual([]);
  });

  it("kitImplsByDomain narrows a single language kit to a domain (per-tech ∩ per-domain)", () => {
    expect(kitImplsByDomain(g, "rust", "logistics").map((i) => i.id)).toEqual(["dijkstra.rs", "a-star.rs"]);
    expect(kitImplsByDomain(g, "typescript", "logistics").map((i) => i.id)).toEqual(["route.ts"]);
    expect(kitImplsByDomain(g, "rust", "graphics")).toEqual([]); // graphics has no Rust impl
  });
});
