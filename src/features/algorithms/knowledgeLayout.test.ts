import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE, kitGraph, layoutKitGraph, originOf, clusterOf, NODE_H,
  type AlgoImpl, type KitGraph,
} from "@/features/algorithms/lib/knowledge";

/** A node with just the fields the layout reads. */
const impl = (id: string, over: Partial<AlgoImpl> = {}): AlgoImpl => ({
  id, tech: "typescript", role: "algorithm", name: id, composes: [], ...over,
});
const kit = (nodes: AlgoImpl[]): KitGraph => ({ nodes, edges: [] });

describe("origin banding", () => {
  it("separates crate code from frontend code — the split the crate migration needs", () => {
    expect(originOf(impl("a", { src: "crates/bsc-shot/src/lib.rs" }))).toBe("crates");
    expect(originOf(impl("b", { src: "src-tauri/src/session/launch.rs" }))).toBe("backend");
    expect(originOf(impl("c", { src: "src/features/glance/lib/x.ts" }))).toBe("features");
    expect(originOf(impl("d", { src: "src/shared/lib/core/y.ts" }))).toBe("shared");
    expect(originOf(impl("e", { src: "src/app/console/z.ts" }))).toBe("shell");
    expect(originOf(impl("f", { src: "src/store/slices/s.ts" }))).toBe("store");
  });

  /** The textbook algorithms (a-star.rs, bfs.rs) carry no `src` and are NOT codebase code — they are a
   *  third population that should not mix into either the crates or the frontend. */
  it("keeps reference algorithms and language built-ins out of the codebase bands", () => {
    expect(originOf(impl("a-star.rs", { src: undefined }))).toBe("reference");
    expect(originOf(impl("rust.vec", { role: "primitive" }))).toBe("built-ins");
  });

  it("clusters by the crate, the feature, or the folder — what the rail already navigates by", () => {
    expect(clusterOf(impl("a", { src: "crates/bsc-shot/src/lib.rs" }))).toBe("bsc-shot");
    expect(clusterOf(impl("b", { src: "src/features/planner/lib/x.ts" }))).toBe("planner");
    expect(clusterOf(impl("c", { src: "src/shared/lib/core/y.ts", folder: "shared/lib/core" }))).toBe("shared/lib/core");
    expect(clusterOf(impl("d", {}))).toBe("general");
  });
});

describe("layoutKitGraph", () => {
  /**
   * THE REGRESSION THIS EXISTS FOR. The old layout put a node in the column of its compose depth and
   * stacked with no wrap; 538 of 644 typescript nodes are depth 1, so one column ran 43,114px down —
   * 52 screens of travel to reach a node. Asserted against the REAL packaged graph, because a synthetic
   * fixture cannot reproduce the depth-1 pile-up that caused it.
   */
  it("keeps the real typescript kit to a screen-shaped world, not a 43,000px column", () => {
    const laid = layoutKitGraph(kitGraph(KNOWLEDGE, "typescript"));
    expect(laid.pos.size).toBeGreaterThan(100);
    expect(laid.world.h).toBeLessThan(12_000);
    // Aspect, not just height: wrapping the depths alone was measured at 8,280px WIDE, which is the
    // same problem rotated. Neither side may run away from the other.
    const aspect = laid.world.h / laid.world.w;
    expect(aspect).toBeGreaterThan(0.2);
    expect(aspect).toBeLessThan(5);
  });

  it("gives every node a position, and never two nodes the same one", () => {
    const laid = layoutKitGraph(kitGraph(KNOWLEDGE, "typescript"));
    const seen = new Set([...laid.pos.values()].map((p) => `${p.x},${p.y}`));
    expect(seen.size).toBe(laid.pos.size);
  });

  it("is pure — the same graph lays out identically twice", () => {
    const g = kitGraph(KNOWLEDGE, "typescript");
    const a = layoutKitGraph(g);
    const b = layoutKitGraph(g);
    expect([...b.pos].map(([k, v]) => [k, v.x, v.y])).toEqual([...a.pos].map(([k, v]) => [k, v.x, v.y]));
  });

  it("bands are laid out in ORIGIN_BANDS order, each below the last", () => {
    const laid = layoutKitGraph(kit([
      impl("c1", { src: "crates/bsc-shot/src/lib.rs" }),
      impl("f1", { src: "src/features/glance/a.ts" }),
      impl("r1", {}),
    ]));
    const band = (o: string) => laid.clusters.find((c) => c.origin === o)!;
    expect(band("crates").y).toBeLessThan(band("features").y);
    expect(band("features").y).toBeLessThan(band("reference").y);
  });

  /** Depth is no longer the global axis, but base-to-derived must still read INSIDE a cluster. */
  it("orders a cluster by compose depth, shallowest first", () => {
    const nodes = [
      impl("deep.ts", { src: "src/shared/x/deep.ts", folder: "f", composes: ["mid.ts"] }),
      impl("mid.ts", { src: "src/shared/x/mid.ts", folder: "f", composes: ["base.ts"] }),
      impl("base.ts", { src: "src/shared/x/base.ts", folder: "f" }),
    ];
    const laid = layoutKitGraph(kit(nodes));
    const y = (id: string) => laid.pos.get(id)!.y;
    const x = (id: string) => laid.pos.get(id)!.x;
    // One column at this size, so "earlier" is "higher".
    expect(y("base.ts")).toBeLessThanOrEqual(y("mid.ts"));
    expect(y("mid.ts")).toBeLessThanOrEqual(y("deep.ts"));
    expect(new Set([x("base.ts"), x("mid.ts"), x("deep.ts")]).size).toBe(1);
  });

  it("an empty kit is a degenerate world rather than a crash", () => {
    const laid = layoutKitGraph(kit([]));
    expect(laid.pos.size).toBe(0);
    expect(laid.world.w).toBeGreaterThan(0);
    expect(laid.world.h).toBeGreaterThan(0);
    expect(laid.clusters).toEqual([]);
  });

  it("a single node still gets a real box", () => {
    const laid = layoutKitGraph(kit([impl("only.ts", { src: "src/shared/a/only.ts", folder: "a" })]));
    expect(laid.pos.size).toBe(1);
    expect(laid.world.h).toBeGreaterThan(NODE_H);
    expect(laid.clusters).toHaveLength(1);
    expect(laid.clusters[0].count).toBe(1);
  });
});
