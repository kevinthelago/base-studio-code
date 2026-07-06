// orderLayers (#2418) — the shared barycenter crossing-reduction primitive: determinism, crossing
// reduction on a small fixture, the no-neighbor fallback, and the tunables (passes / sweep).
import { describe, it, expect } from "vitest";
import { orderLayers } from "./order";

/** Two layers, two nodes each, wired in an X: a1–q and a2–p cross in the seed order. */
const crossed = () => {
  const layer: Record<string, number> = { p: 0, q: 0, a1: 1, a2: 1 };
  const nb: Record<string, string[]> = { a1: ["q"], a2: ["p"], q: ["a1"], p: ["a2"] };
  return {
    nodeIds: ["p", "q", "a1", "a2"],
    layerOf: (id: string) => layer[id],
    neighborsOf: (id: string) => nb[id] ?? [],
  };
};

describe("orderLayers (#2418)", () => {
  it("groups nodes by layer in seed (nodeIds) order, layers ascending", () => {
    const out = orderLayers(["b", "a", "c"], (id) => (id === "c" ? 1 : 0), () => [], { passes: 0 });
    expect([...out.keys()]).toEqual([0, 1]);
    expect(out.get(0)).toEqual(["b", "a"]); // seed order preserved
    expect(out.get(1)).toEqual(["c"]);
  });

  it("is deterministic — the same input gives the same order", () => {
    const f = crossed();
    const a = orderLayers(f.nodeIds, f.layerOf, f.neighborsOf, { passes: 4 });
    const b = orderLayers(f.nodeIds, f.layerOf, f.neighborsOf, { passes: 4 });
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("reduces crossings: the X fixture untangles (sequential sweep)", () => {
    const f = crossed();
    const out = orderLayers(f.nodeIds, f.layerOf, f.neighborsOf); // defaults: 4 passes, sequential
    // After the sweep each consumer sits directly over its provider — 0 crossings.
    const l0 = out.get(0)!, l1 = out.get(1)!;
    expect(l0.indexOf("q") < l0.indexOf("p")).toBe(l1.indexOf("a1") < l1.indexOf("a2"));
  });

  it("a node with no (known) neighbors holds its slot; unknown neighbor ids are ignored", () => {
    const layer: Record<string, number> = { x: 0, lone: 0, c: 1 };
    // `lone`'s only "neighbor" is unknown → it behaves as neighborless (bary = its own index).
    const nb: Record<string, string[]> = { x: ["c", "ghost"], c: ["x"], lone: ["ghost"] };
    const out = orderLayers(["x", "lone", "c"], (id) => layer[id], (id) => nb[id] ?? []);
    expect(out.get(0)).toEqual(["x", "lone"]);
    // Seeded the other way round it also holds: bary(lone)=0 ties bary(x)=0, stable sort keeps it.
    const flipped = orderLayers(["lone", "x", "c"], (id) => layer[id], (id) => nb[id] ?? []);
    expect(flipped.get(0)).toEqual(["lone", "x"]);
  });

  it("multiplicity counts — a doubly-connected neighbor pulls twice as hard", () => {
    // Layer 0 [l, r] is neighborless (holds still). Layer 1 seeds as [m, s]: m is pulled by r (idx 1)
    // TWICE (bary 1), s by one edge each way (bary 0.5) → m sorts after s.
    const layer: Record<string, number> = { l: 0, r: 0, m: 1, s: 1 };
    const nb: Record<string, string[]> = { m: ["r", "r"], s: ["l", "r"] };
    const out = orderLayers(["l", "r", "m", "s"], (id) => layer[id], (id) => nb[id] ?? [], { passes: 1 });
    expect(out.get(0)).toEqual(["l", "r"]);
    expect(out.get(1)).toEqual(["s", "m"]);
  });

  it("passes: 0 returns the seed order untouched", () => {
    const f = crossed();
    const out = orderLayers(f.nodeIds, f.layerOf, f.neighborsOf, { passes: 0 });
    expect(out.get(0)).toEqual(["p", "q"]);
    expect(out.get(1)).toEqual(["a1", "a2"]);
  });

  it("snapshot sweep sorts every layer against the pass-start order", () => {
    // In the X fixture a snapshot pass flips BOTH layers (each sorts against the stale other), so the
    // crossing survives one pass — the discipline glance historically ran (it converges on real data).
    const f = crossed();
    const out = orderLayers(f.nodeIds, f.layerOf, f.neighborsOf, { passes: 1, sweep: "snapshot" });
    expect(out.get(0)).toEqual(["q", "p"]);
    expect(out.get(1)).toEqual(["a2", "a1"]);
  });
});
