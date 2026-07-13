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

  it("bands purely by ROLE tier, top → bottom: page → layout → composable → fundamental (#2970)", () => {
    const comps = [mk("Page", "page"), mk("Box", "layout"), mk("Card", "composite"), mk("Button", "primitive")];
    const { depth, pos, tier } = layoutComposition(comps);
    expect([tier.get("page"), tier.get("box"), tier.get("card"), tier.get("button")])
      .toEqual(["page", "layout", "composable", "fundamental"]);
    expect([depth.get("page"), depth.get("box"), depth.get("card"), depth.get("button")]).toEqual([0, 1, 2, 3]);
    expect(pos.get("box")!.y).toBeLessThan(pos.get("card")!.y); // layouts sit ABOVE composables (#2970)
  });
});

describe("nodeTier — the semantic tier of a node (#2970)", () => {
  it("maps role → tier: page→page, layout→layout, primitive→fundamental, else→composable", () => {
    expect(nodeTier("page")).toBe("page");
    expect(nodeTier("layout")).toBe("layout");         // a structural positioner (Box, Stack, …)
    expect(nodeTier("primitive")).toBe("fundamental"); // a content atom (Button, Text, …)
    expect(nodeTier("composite")).toBe("composable");  // an assembled widget (Card, Dialog, …)
    expect(nodeTier("service")).toBe("composable");    // service groups with composables
  });
});

describe("layoutComposition — role tiers (#2970)", () => {
  it("stacks Pages · Layouts · Composables · Fundamentals top → bottom", () => {
    const comps = [
      mk("DashboardPage", "page", 0, ["Stack"]),
      mk("Stack", "layout"),
      mk("Card", "composite", 0, ["Button"]),
      mk("Button", "primitive"),
    ];
    const { pos } = layoutComposition(comps);
    expect(pos.get("dashboardpage")!.y).toBeLessThan(pos.get("stack")!.y);
    expect(pos.get("stack")!.y).toBeLessThan(pos.get("card")!.y);   // Layouts above Composables (#2970)
    expect(pos.get("card")!.y).toBeLessThan(pos.get("button")!.y);
  });

  it("keeps a ROOT composable (in-degree 0) out of the page band — pages own the top", () => {
    // ItemBars/RoleTierChips are composites nothing composes → roots; role tiers put them in
    // Composables regardless, never up with the pages.
    const comps = [mk("NetworkPage", "page"), mk("ItemBars", "composite", 0, ["Bar"]), mk("Bar", "primitive")];
    const { pos, depth } = layoutComposition(comps);
    expect(depth.get("networkpage")).toBe(0);
    expect(pos.get("networkpage")!.y).toBeLessThan(pos.get("itembars")!.y);
  });

  it("puts every primitive in ONE fundamental band at the very base; a leaf layout stays in Layouts", () => {
    const comps = [
      mk("Page", "page", 0, ["Card"]),
      mk("Card", "composite", 0, ["Button", "Box"]),
      mk("Box", "layout"),          // a leaf layout → Layouts, NOT the base
      mk("Button", "primitive"), mk("Text", "primitive"),
    ];
    const { pos, depth, tier } = layoutComposition(comps);
    expect(tier.get("box")).toBe("layout");
    for (const n of ["button", "text"]) expect(tier.get(n)).toBe("fundamental");
    expect(pos.get("button")!.y).toBe(pos.get("text")!.y); // one fundamental band → one y
    const maxDepth = Math.max(...depth.values());
    for (const n of ["button", "text"]) expect(depth.get(n)).toBe(maxDepth);
    expect(depth.get("box")).toBeLessThan(maxDepth); // Box (layout) sits above the base
  });
});

describe("layoutComposition — swimlanes (#2970)", () => {
  it("returns one lane per present tier, top → bottom, tiled to fill the world height", () => {
    const comps = [mk("Page", "page"), mk("Box", "layout"), mk("Card", "composite"), mk("Button", "primitive")];
    const { lanes, world } = layoutComposition(comps);
    expect(lanes.map((l) => l.tier)).toEqual(["page", "layout", "composable", "fundamental"]);
    expect(lanes.map((l) => l.label)).toEqual(["Pages", "Layouts", "Composables", "Fundamentals"]);
    expect(lanes[0].y0).toBe(0);                        // the top lane starts at the world top
    expect(lanes[lanes.length - 1].y1).toBe(world.h);   // the bottom lane ends at the world bottom
    for (let i = 1; i < lanes.length; i++) expect(lanes[i].y0).toBe(lanes[i - 1].y1); // tiled, no gaps/overlap
  });

  it("omits a lane for an absent tier (no layouts → no Layouts lane)", () => {
    const comps = [mk("Page", "page"), mk("Card", "composite"), mk("Button", "primitive")];
    const { lanes } = layoutComposition(comps);
    expect(lanes.map((l) => l.tier)).toEqual(["page", "composable", "fundamental"]);
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
