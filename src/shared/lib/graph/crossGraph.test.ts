// Cross-graph resolution + the `requires` edge + the fenced band (#3115, epic #3114).
import { describe, it, expect } from "vitest";
import {
  makeUrnResolver,
  crossGraphEdgeId,
  layoutBand,
  type NodeLookup,
  type ResolvedNode,
} from "./crossGraph";

// A tiny fake store per graph — the shape a feature would adapt its hydrated data into.
const ALGOS: Record<string, Record<string, { label: string; kind: string; code?: string }>> = {
  typescript: { "fibonacci.ts": { label: "fibonacci", kind: "algorithm", code: "export const fib = () => 1" } },
  rust: { "merge-sort.rs": { label: "merge sort", kind: "algorithm", code: "fn merge_sort() {}" } },
};
const SOUNDS: Record<string, Record<string, { label: string; kind: string }>> = {
  default: { click: { label: "Click", kind: "cue" } },
};

const algoLookup: NodeLookup = (kit, id) => {
  const hit = ALGOS[kit]?.[id];
  return hit ? ({ urn: "", graph: "algo", kit, id, label: hit.label, kind: hit.kind, code: hit.code } as ResolvedNode) : null;
};
const soundLookup: NodeLookup = (kit, id) => {
  const hit = SOUNDS[kit]?.[id];
  return hit ? ({ urn: "", graph: "sound", kit, id, label: hit.label, kind: hit.kind } as ResolvedNode) : null;
};

describe("makeUrnResolver (#3115)", () => {
  const resolve = makeUrnResolver({ algo: algoLookup, sound: soundLookup });

  it("resolves a hit and carries its impl payload", () => {
    const n = resolve("algo:typescript/fibonacci.ts");
    expect(n).toMatchObject({ graph: "algo", kit: "typescript", id: "fibonacci.ts", label: "fibonacci", kind: "algorithm" });
    expect(n?.code).toContain("fib");
    expect(n?.urn).toBe("algo:typescript/fibonacci.ts"); // identity stamped from the URN, not the lookup
  });

  it("resolves across graphs from one composed resolver", () => {
    expect(resolve("sound:default/click")?.label).toBe("Click");
  });

  it("returns null for a lookup miss (unknown kit or id)", () => {
    expect(resolve("algo:typescript/nope.ts")).toBeNull();
    expect(resolve("algo:python/x.py")).toBeNull();
  });

  it("returns null for a graph the registry doesn't cover, instead of throwing", () => {
    expect(resolve("ui:react-ui/Sparkline")).toBeNull(); // no `ui` lookup registered
  });

  it("returns null for a malformed URN", () => {
    expect(resolve("not-a-urn")).toBeNull();
  });

  it("overwrites identity from the URN so a lookup can't mislabel it", () => {
    const liar: NodeLookup = () => ({ urn: "x", graph: "sound", kit: "wrong", id: "wrong", label: "L", kind: "algorithm" });
    const r = makeUrnResolver({ algo: liar });
    expect(r("algo:typescript/fibonacci.ts")).toMatchObject({ graph: "algo", kit: "typescript", id: "fibonacci.ts" });
  });
});

describe("crossGraphEdgeId (#3115)", () => {
  it("is stable + distinguishes endpoints", () => {
    expect(crossGraphEdgeId("ui:react-ui/Chart", "algo:typescript/fibonacci.ts")).toBe(
      "ui:react-ui/Chart~requires~algo:typescript/fibonacci.ts",
    );
    expect(crossGraphEdgeId("a:k/1", "b:k/2")).not.toBe(crossGraphEdgeId("b:k/2", "a:k/1"));
  });
});

describe("layoutBand (#3115, generalized from Glance #3007)", () => {
  const opts = { spanX0: 70, spanX1: 70 + 3 * 252, topPad: 40, nodeH: 66, gap: 34, maxStep: 252 };

  it("no nodes → no positions, but still reports the divider", () => {
    const b = layoutBand(0, opts);
    expect(b.positions).toEqual([]);
    expect(b.dividerY).toBe(40 + 66 + 34);
    expect(b.y1).toBe(b.dividerY);
  });

  it("a single node centers over the span at topPad", () => {
    const b = layoutBand(1, opts);
    expect(b.positions).toHaveLength(1);
    expect(b.positions[0].y).toBe(40);
    const spanMid = 70 + (opts.spanX1 - 70) / 2;
    expect(b.positions[0].x).toBeCloseTo(spanMid);
  });

  it("multiple nodes spread evenly, capped by maxStep", () => {
    const b = layoutBand(3, opts);
    expect(b.positions.map((p) => p.y)).toEqual([40, 40, 40]);
    const step = b.positions[1].x - b.positions[0].x;
    expect(step).toBeLessThanOrEqual(opts.maxStep);
    expect(step).toBeGreaterThan(0);
    // evenly spaced
    expect(b.positions[2].x - b.positions[1].x).toBeCloseTo(step);
  });

  it("caps the step so a few nodes cluster instead of stretching the full width", () => {
    const wide = { ...opts, spanX1: 70 + 5000 };
    const b = layoutBand(2, wide);
    expect(b.positions[1].x - b.positions[0].x).toBe(opts.maxStep);
  });
});
