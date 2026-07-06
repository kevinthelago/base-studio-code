import { describe, it, expect } from "vitest";
import {
  layoutComposition, buildComposesEdges, TIER_INDEX, DEFAULT_METRICS, NODE_W, NODE_H,
} from "./compositionLayout";
import type { ComponentRecord, Role } from "./model";

const mk = (name: string, role: Role, used = 0, composes: string[] = []): ComponentRecord => ({
  id: name.toLowerCase(), name, kitId: "k", role, version: "1.0.0", used, tags: [],
  variants: ["default"], composes, props: [], whenUse: [], whenNot: [],
  src: `${name}.tsx`, srcText: "", builtin: true,
});

describe("buildComposesEdges", () => {
  it("resolves composes names to in-kit edges and drops unresolvable names", () => {
    const comps = [mk("A", "composite", 0, ["B", "NotInKit"]), mk("B", "primitive")];
    const edges = buildComposesEdges(comps);
    expect(edges).toEqual([{ id: "a->b", from: "a", to: "b" }]);
  });
});

describe("layoutComposition — top-down DAG placement", () => {
  it("places a composer strictly ABOVE its dependency (rows, not columns)", () => {
    const comps = [mk("Parent", "composite", 0, ["Child"]), mk("Child", "primitive")];
    const { pos } = layoutComposition(comps);
    expect(pos.get("parent")!.y).toBeLessThan(pos.get("child")!.y);
    // Same column-center — vertical flow, no horizontal layering.
    expect(pos.get("parent")!.x).toBe(pos.get("child")!.x);
  });

  it("keeps each connected node at its layerDag depth (longest incoming chain)", () => {
    const comps = [
      mk("Top", "layout", 0, ["Mid", "Leaf"]),
      mk("Mid", "composite", 0, ["Leaf"]),
      mk("Leaf", "primitive"),
    ];
    const { depth } = layoutComposition(comps);
    expect(depth.get("top")).toBe(0);
    expect(depth.get("mid")).toBe(1);
    expect(depth.get("leaf")).toBe(2); // longest chain wins, not the direct Top→Leaf edge
  });
});

describe("layoutComposition — role-tier fallback for isolated nodes", () => {
  it("with NO edges at all, bands purely by role tier: page → layout → composite → primitive", () => {
    const comps = [mk("Prim", "primitive"), mk("Page", "page"), mk("Comp", "composite"), mk("Lay", "layout")];
    const { pos, depth } = layoutComposition(comps);
    expect(depth.get("page")).toBe(0);
    expect(depth.get("lay")).toBe(1);
    expect(depth.get("comp")).toBe(2);
    expect(depth.get("prim")).toBe(3);
    expect(pos.get("page")!.y).toBeLessThan(pos.get("lay")!.y);
    expect(pos.get("lay")!.y).toBeLessThan(pos.get("comp")!.y);
    expect(pos.get("comp")!.y).toBeLessThan(pos.get("prim")!.y);
  });

  it("bands service alongside composite", () => {
    const comps = [mk("Svc", "service"), mk("Comp", "composite"), mk("Page", "page")];
    const { pos, depth } = layoutComposition(comps);
    expect(TIER_INDEX.service).toBe(TIER_INDEX.composite);
    expect(depth.get("svc")).toBe(depth.get("comp"));
    expect(pos.get("svc")!.y).toBe(pos.get("comp")!.y);
  });

  it("maps isolated nodes INLINE onto a representative DAG depth (top/middle/bottom of a 3-deep DAG)", () => {
    const comps = [
      // A depth-0..2 connected chain.
      mk("Top", "composite", 0, ["Mid"]), mk("Mid", "composite", 0, ["Leaf"]), mk("Leaf", "primitive"),
      // Isolated nodes of each tier.
      mk("IsoPage", "page"), mk("IsoLayout", "layout"), mk("IsoComp", "composite"), mk("IsoPrim", "primitive"),
    ];
    const { depth, pos } = layoutComposition(comps);
    // floor(tier · (maxDepth+1) / 4) with maxDepth 2 → page 0, layout 0, composite 1, primitive 2.
    expect(depth.get("isopage")).toBe(0);
    expect(depth.get("isolayout")).toBe(0);
    expect(depth.get("isocomp")).toBe(1);
    expect(depth.get("isoprim")).toBe(2);
    // Inline: the isolated node shares its band's row y with the connected node of the same depth.
    expect(pos.get("isocomp")!.y).toBe(pos.get("mid")!.y);
    expect(pos.get("isoprim")!.y).toBe(pos.get("leaf")!.y);
  });

  it("never bands an isolated node below the deepest connected row", () => {
    const comps = [mk("A", "composite", 0, ["B"]), mk("B", "primitive"), mk("IsoPrim", "primitive")];
    const { depth } = layoutComposition(comps); // maxDepth 1 → primitive clamps to 1
    expect(depth.get("isoprim")).toBe(1);
  });
});

describe("layoutComposition — importance ordering within a row", () => {
  it("orders a row by `used` descending with a stable name tiebreak", () => {
    const comps = [mk("Zeta", "primitive", 5), mk("Alpha", "primitive", 90), mk("Beta", "primitive", 5)];
    const { pos } = layoutComposition(comps);
    expect(pos.get("alpha")!.x).toBeLessThan(pos.get("beta")!.x);  // 90 before 5
    expect(pos.get("beta")!.x).toBeLessThan(pos.get("zeta")!.x);   // tie → name order
    // Same row — ordering only, no vertical scatter.
    expect(new Set([pos.get("alpha")!.y, pos.get("beta")!.y, pos.get("zeta")!.y]).size).toBe(1);
  });
});

describe("layoutComposition — rows wrap and the world fits", () => {
  it("wraps a band onto sub-rows past maxPerRow, keeping it above the next band", () => {
    const comps = [
      ...Array.from({ length: 5 }, (_, i) => mk(`C${i}`, "composite", 0, ["Leaf"])),
      mk("Leaf", "primitive"),
    ];
    const { pos } = layoutComposition(comps, { ...DEFAULT_METRICS, maxPerRow: 3 });
    const ys = new Set(Array.from({ length: 5 }, (_, i) => pos.get(`c${i}`)!.y));
    expect(ys.size).toBe(2); // 5 composers wrap into 2 sub-rows
    for (const y of ys) expect(y).toBeLessThan(pos.get("leaf")!.y);
  });

  it("computes a world that contains every node plus padding (min 400×300)", () => {
    const comps = [mk("A", "composite", 0, ["B"]), ...Array.from({ length: 9 }, (_, i) => mk(`B${i}`, "primitive")), mk("B", "primitive")];
    const { pos, world } = layoutComposition(comps);
    for (const p of pos.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + NODE_W).toBeLessThanOrEqual(world.w);
      expect(p.y + NODE_H).toBeLessThanOrEqual(world.h);
    }
    const empty = layoutComposition([]);
    expect(empty.world).toEqual({ w: 400, h: 300 });
  });
});
