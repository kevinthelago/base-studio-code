import { describe, it, expect } from "vitest";
import {
  layoutComposition, buildComposesEdges, selectionNeighborhood, nodeTier, DEFAULT_METRICS, NODE_W, NODE_H,
} from "./compositionLayout";
import type { GraphEdge } from "@/shared/lib/graph/types";
import type { ComponentRecord, Role } from "./model";

const mk = (name: string, role: Role, used = 0, composes: string[] = []): ComponentRecord => ({
  id: name.toLowerCase(), name, kitId: "k", role, version: "1.0.0", used, tags: [],
  variants: ["default"], composes, props: [], whenUse: [], whenNot: [],
  src: `${name}.tsx`, srcText: "", builtin: true,
});

describe("selectionNeighborhood (#2523)", () => {
  // a→b, a→c, d→a (so `a` is incident to all three; b/c are downstream, d is upstream).
  const edges: GraphEdge[] = [
    { id: "a->b", from: "a", to: "b" },
    { id: "a->c", from: "a", to: "c" },
    { id: "d->a", from: "d", to: "a" },
    { id: "e->f", from: "e", to: "f" }, // an unrelated edge, never incident to `a`
  ];

  it("collects the edges touching the selection (from OR to) and the far-end nodes", () => {
    const { incidentEdges, relatedNodes } = selectionNeighborhood(edges, "a");
    expect([...incidentEdges].sort()).toEqual(["a->b", "a->c", "d->a"]);
    expect([...relatedNodes].sort()).toEqual(["b", "c", "d"]);
    expect(relatedNodes.has("a")).toBe(false); // the selection is never its own relation
    expect(relatedNodes.has("f")).toBe(false); // the unrelated edge contributes nothing
  });

  it("is empty when nothing is selected", () => {
    const { incidentEdges, relatedNodes } = selectionNeighborhood(edges, "");
    expect(incidentEdges.size).toBe(0);
    expect(relatedNodes.size).toBe(0);
  });

  it("a self-loop never marks the selection as related to itself", () => {
    const { relatedNodes } = selectionNeighborhood([{ id: "a->a", from: "a", to: "a" }], "a");
    expect(relatedNodes.size).toBe(0);
  });
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

describe("nodeTier — the semantic tier of a node (#2964)", () => {
  it("a page is a page; a primitive or ANY leaf is a fundamental; an assembler is a composable", () => {
    expect(nodeTier("page", 3)).toBe("page");
    expect(nodeTier("primitive", 0)).toBe("fundamental");
    expect(nodeTier("primitive", 2)).toBe("fundamental"); // primitive stays fundamental even if it composes
    expect(nodeTier("layout", 0)).toBe("fundamental");    // a LEAF layout (Card) is a fundamental
    expect(nodeTier("layout", 3)).toBe("composable");     // a layout that ASSEMBLES is a composable
    expect(nodeTier("composite", 2)).toBe("composable");
    expect(nodeTier("service", 1)).toBe("composable");    // service groups with composables
    expect(nodeTier("service", 0)).toBe("fundamental");
  });
});

describe("layoutComposition — semantic tiers (#2964)", () => {
  it("stacks pages at the TOP, composables in the MIDDLE, fundamentals at the BASE", () => {
    const comps = [
      mk("Page", "page", 0, ["Assembler"]),
      mk("Assembler", "composite", 0, ["Card"]),
      mk("Card", "layout"), // leaf → fundamental
    ];
    const { pos, tier } = layoutComposition(comps);
    expect(tier.get("page")).toBe("page");
    expect(tier.get("assembler")).toBe("composable");
    expect(tier.get("card")).toBe("fundamental");
    expect(pos.get("page")!.y).toBeLessThan(pos.get("assembler")!.y);
    expect(pos.get("assembler")!.y).toBeLessThan(pos.get("card")!.y);
  });

  it("drops a ROOT composable (in-degree 0) BELOW the pages, not up with them", () => {
    // The bug this fixes: ItemBars/RoleTierChips are composites nothing composes → composition roots.
    // They must NOT share the page band; pages own the top.
    const comps = [
      mk("NetworkPage", "page", 0, ["Card"]),
      mk("ItemBars", "composite", 0, ["Bar"]), // a root composable — nothing composes it
      mk("Card", "layout"),
      mk("Bar", "primitive"),
    ];
    const { pos, depth } = layoutComposition(comps);
    expect(depth.get("networkpage")).toBe(0);          // page band — alone at the top
    expect(depth.get("itembars")).toBeGreaterThan(0);  // dropped into the composables lane
    expect(pos.get("networkpage")!.y).toBeLessThan(pos.get("itembars")!.y);
  });

  it("puts every leaf/primitive in ONE fundamental band at the very base", () => {
    const comps = [
      mk("Page", "page", 0, ["A"]),
      mk("A", "composite", 0, ["Card", "Button"]),
      mk("Card", "layout"), mk("Button", "primitive"), mk("Box", "layout"), // all leaves
    ];
    const { pos, depth, tier } = layoutComposition(comps);
    for (const n of ["card", "button", "box"]) expect(tier.get(n)).toBe("fundamental");
    expect(new Set(["card", "button", "box"].map((n) => pos.get(n)!.y)).size).toBe(1); // one band → one y
    const maxDepth = Math.max(...depth.values());
    for (const n of ["card", "button", "box"]) expect(depth.get(n)).toBe(maxDepth); // and it's the deepest
  });

  it("sub-orders composables by composition depth (a composable that composes another sits above it)", () => {
    const comps = [
      mk("Page", "page", 0, ["Outer"]),
      mk("Outer", "composite", 0, ["Inner"]),
      mk("Inner", "composite", 0, ["Leaf"]),
      mk("Leaf", "primitive"),
    ];
    const { pos, tier } = layoutComposition(comps);
    expect(tier.get("outer")).toBe("composable");
    expect(tier.get("inner")).toBe("composable");
    expect(pos.get("outer")!.y).toBeLessThan(pos.get("inner")!.y); // Outer composes Inner → above it
  });
});

describe("layoutComposition — swimlanes (#2964)", () => {
  it("returns one lane per present tier, top → bottom, tiled to fill the world height", () => {
    const comps = [mk("Page", "page", 0, ["Asm"]), mk("Asm", "composite", 0, ["Card"]), mk("Card", "layout")];
    const { lanes, world } = layoutComposition(comps);
    expect(lanes.map((l) => l.tier)).toEqual(["page", "composable", "fundamental"]);
    expect(lanes.map((l) => l.label)).toEqual(["Pages", "Composables", "Fundamentals"]);
    expect(lanes[0].y0).toBe(0);                        // the top lane starts at the world top
    expect(lanes[lanes.length - 1].y1).toBe(world.h);   // the bottom lane ends at the world bottom
    for (let i = 1; i < lanes.length; i++) expect(lanes[i].y0).toBe(lanes[i - 1].y1); // tiled, no gaps/overlap
  });

  it("omits a lane for an absent tier (no pages → no Pages lane)", () => {
    const comps = [mk("Asm", "composite", 0, ["Card"]), mk("Card", "layout")];
    const { lanes } = layoutComposition(comps);
    expect(lanes.map((l) => l.tier)).toEqual(["composable", "fundamental"]);
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
