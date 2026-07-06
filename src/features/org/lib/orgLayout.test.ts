import { describe, it, expect } from "vitest";
import { nodeBox, edgeGeometry, styleDash, autoLayout, layerNodes, NODE_SIZE, CANVAS_W, CANVAS_H, AUTO_ROW } from "./orgLayout";
import { anchor } from "@/shared/lib/graph/edgePath";
import { BUILTIN_ORGS, type Org, type Position } from "./org";

describe("orgLayout geometry (#2193)", () => {
  it("nodeBox uses the position's x/y + the size for its kind", () => {
    const p: Position = { nodeId: "a", kind: "agent", x: 100, y: 50 };
    expect(nodeBox(p)).toEqual({ x: 100, y: 50, w: NODE_SIZE.agent.w, h: NODE_SIZE.agent.h });
    // A resource is smaller; an unplaced node sits at the origin.
    expect(nodeBox({ nodeId: "r", kind: "resource" })).toMatchObject({ x: 0, y: 0, w: NODE_SIZE.resource.w });
  });

  it("anchor (the shared edgePath one — org's copy was deleted, #2418) lands on the box perimeter toward the target", () => {
    const box = { x: 0, y: 0, w: 100, h: 100 }; // center (50,50)
    // A target far to the right exits the right edge (x = w + 3 outset).
    const [x, y] = anchor(box, 500, 50);
    expect(x).toBeCloseTo(103, 0);
    expect(y).toBeCloseTo(50, 0);
  });

  it("edgeGeometry returns a cubic path + a label midpoint between the two boxes", () => {
    const A = { x: 0, y: 0, w: 100, h: 60 };
    const B = { x: 400, y: 0, w: 100, h: 60 };
    const g = edgeGeometry(A, B, 0);
    expect(g.d.startsWith("M ")).toBe(true);
    expect(g.d).toContain(" C "); // a cubic bezier
    // With no bow, the label sits on the straight line between the facing edges (y ≈ center 30).
    expect(g.ly).toBeCloseTo(30, 0);
    expect(g.lx).toBeGreaterThan(100);
    expect(g.lx).toBeLessThan(400);
  });

  it("a bow pushes the label off the straight line", () => {
    const A = { x: 0, y: 0, w: 100, h: 60 };
    const B = { x: 400, y: 0, w: 100, h: 60 };
    expect(edgeGeometry(A, B, 40).ly).not.toBeCloseTo(30, 0);
  });

  it("styleDash maps archetype styles to SVG dash arrays", () => {
    expect(styleDash("solid")).toBe("0");
    expect(styleDash("dashed")).toBe("7 5");
    expect(styleDash("gated")).toBe("3 5");
    expect(styleDash("dotted")).toBe("1 6");
  });

  // clampZoom was deleted (#2418): it had no callers — useGraphViewport owns zoom clamping.
});

describe("layerNodes — shared layerDag parity (#2418)", () => {
  /** The pre-#2418 PRIVATE longest-path layerer, kept verbatim as the parity oracle. On an acyclic
   *  hierarchy the shared `layerDag` path must assign identical layers. */
  const oldLayers = (org: Org): Map<string, number> => {
    const HIER = new Set(["manages", "serves", "oversees", "stewards"]);
    const ids = org.positions.map((p) => p.nodeId);
    const parents = new Map<string, string[]>(ids.map((n) => [n, []]));
    for (const r of org.relationships) {
      if (!HIER.has(r.archetype) || !parents.has(r.to) || !parents.has(r.from)) continue;
      parents.get(r.to)!.push(r.from);
    }
    const layer = new Map<string, number>();
    const active = new Set<string>();
    const calc = (n: string): number => {
      const cached = layer.get(n);
      if (cached !== undefined) return cached;
      if (active.has(n)) return 0; // cycle — break it
      active.add(n);
      const ps = parents.get(n)!;
      const l = ps.length === 0 ? 0 : Math.max(...ps.map(calc)) + 1;
      active.delete(n);
      layer.set(n, l);
      return l;
    };
    ids.forEach(calc);
    return layer;
  };

  it("assigns the same layers as the old algorithm on every built-in org", () => {
    expect(BUILTIN_ORGS.length).toBeGreaterThan(0);
    for (const org of BUILTIN_ORGS) {
      const { layer } = layerNodes(org);
      expect(Object.fromEntries(layer)).toEqual(Object.fromEntries(oldLayers(org)));
    }
  });

  it("matches on a multi-level hierarchy with lateral (non-hierarchy) edges mixed in", () => {
    const org: Org = {
      id: "x", name: "x",
      positions: ["boss", "lead", "a", "b", "res"].map((nodeId) => ({ nodeId, kind: "agent" as const })),
      relationships: [
        { id: "e1", archetype: "manages", from: "boss", to: "lead" },
        { id: "e2", archetype: "manages", from: "lead", to: "a" },
        { id: "e3", archetype: "oversees", from: "boss", to: "b" },
        { id: "e4", archetype: "peers", from: "a", to: "b" },      // lateral — must not drive layers
        { id: "e5", archetype: "stewards", from: "lead", to: "res" },
      ],
    };
    const { layer } = layerNodes(org);
    expect(Object.fromEntries(layer)).toEqual(Object.fromEntries(oldLayers(org)));
    expect(layer.get("boss")).toBe(0);
    expect(layer.get("lead")).toBe(1);
    expect(layer.get("a")).toBe(2);
    expect(layer.get("b")).toBe(1);
    expect(layer.get("res")).toBe(2);
  });

  it("breaks a 2-cycle by dropping the DFS back-edge — the forward edge still layers", () => {
    // The old cycle break zeroed the on-stack parent (an order artifact: a landed BELOW b). The shared
    // path drops the closing edge instead, so `a manages b` wins: a above (layer 0), b below (layer 1).
    const org: Org = {
      id: "c", name: "c",
      positions: [{ nodeId: "a", kind: "agent" }, { nodeId: "b", kind: "agent" }],
      relationships: [
        { id: "e1", archetype: "manages", from: "a", to: "b" },
        { id: "e2", archetype: "manages", from: "b", to: "a" },
      ],
    };
    const { layer, order } = layerNodes(org);
    expect(layer.get("a")).toBe(0);
    expect(layer.get("b")).toBe(1);
    expect([...order.keys()]).toEqual([0, 1]);
  });

  it("orders each layer by the barycenter of its cross-layer hierarchy neighbors", () => {
    // Two managers over crossed reports: m2→r1, m1→r2 seeds crossed; the sweep untangles it.
    const org: Org = {
      id: "o", name: "o",
      positions: ["m1", "m2", "r1", "r2"].map((nodeId) => ({ nodeId, kind: "agent" as const })),
      relationships: [
        { id: "e1", archetype: "manages", from: "m1", to: "r2" },
        { id: "e2", archetype: "manages", from: "m2", to: "r1" },
      ],
    };
    const { order } = layerNodes(org);
    const l0 = order.get(0)!, l1 = order.get(1)!;
    // Uncrossed: each report sits under its own manager.
    expect(l0.indexOf("m1") < l0.indexOf("m2")).toBe(l1.indexOf("r2") < l1.indexOf("r1"));
  });
});

describe("autoLayout (#2199)", () => {
  it("places every node with a fresh x/y, deterministically", () => {
    const fleet = BUILTIN_ORGS.find((o) => o.id === "org-default-fleet")!;
    const a = autoLayout(fleet);
    const b = autoLayout(fleet);
    expect(Object.keys(a).sort()).toEqual(fleet.positions.map((p) => p.nodeId).sort());
    expect(a).toEqual(b); // deterministic — a re-runnable baseline
    // every coordinate is a finite number
    expect(Object.values(a).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });

  it("layers a manager above the reports it manages", () => {
    const org: Org = {
      id: "x", name: "x",
      positions: [
        { nodeId: "boss", kind: "agent" }, { nodeId: "a", kind: "agent" }, { nodeId: "b", kind: "agent" },
      ],
      relationships: [
        { id: "e1", archetype: "manages", from: "boss", to: "a" },
        { id: "e2", archetype: "manages", from: "boss", to: "b" },
      ],
    };
    const layout = autoLayout(org);
    // The boss sits on a higher (smaller-y) row than its reports.
    expect(layout.boss.y).toBeLessThan(layout.a.y);
    expect(layout.boss.y).toBeLessThan(layout.b.y);
    // The two reports share a row.
    expect(layout.a.y).toBe(layout.b.y);
  });

  it("force-refines a real fleet into a non-overlapping graph that fits the design space", () => {
    const fleet = BUILTIN_ORGS.find((o) => o.id === "org-default-fleet")!;
    const layout = autoLayout(fleet);
    const boxes = fleet.positions.map((p) => ({ ...NODE_SIZE[p.kind], ...layout[p.nodeId] }));
    // The collision force guarantees breathing room — no two cards overlap.
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap).toBe(false);
      }
    }
    // The whole graph settles inside the 1120×800 design space (repulsion tuned to fit, not to overflow).
    expect(Math.max(...boxes.map((b) => b.x + b.w))).toBeLessThanOrEqual(CANVAS_W);
    expect(Math.max(...boxes.map((b) => b.y + b.h))).toBeLessThanOrEqual(CANVAS_H);
  });

  it("does not choke on a cycle", () => {
    const org: Org = {
      id: "c", name: "c",
      positions: [{ nodeId: "a", kind: "agent" }, { nodeId: "b", kind: "agent" }],
      relationships: [
        { id: "e1", archetype: "manages", from: "a", to: "b" },
        { id: "e2", archetype: "manages", from: "b", to: "a" },
      ],
    };
    expect(() => autoLayout(org)).not.toThrow();
    expect(Object.keys(autoLayout(org))).toHaveLength(2);
  });
});

describe("autoLayout per-node size overrides (#2451)", () => {
  it("keeps an overridden (taller) node's CENTER on its hierarchy row", () => {
    const org: Org = {
      id: "x", name: "x",
      positions: [{ nodeId: "boss", kind: "agent" }, { nodeId: "a", kind: "agent" }],
      relationships: [{ id: "e1", archetype: "manages", from: "boss", to: "a" }],
    };
    const sizes = { boss: { w: 300, h: 156 } };
    const layout = autoLayout(org, sizes);
    // Rows pin node CENTERS one AUTO_ROW apart; a taller box shifts only the returned top-left.
    const bossCy = layout.boss.y + sizes.boss.h / 2;
    const aCy = layout.a.y + NODE_SIZE.agent.h / 2;
    expect(Math.abs(aCy - bossCy - AUTO_ROW)).toBeLessThanOrEqual(1);
  });

  it("collision spaces nodes by their OVERRIDDEN boxes (the stacked-card footprint)", () => {
    // Two disconnected same-layer nodes seeded ~AUTO_COL apart — narrower than the overridden card,
    // so only an override-aware collision pass can separate them.
    const org: Org = {
      id: "x", name: "x",
      positions: [{ nodeId: "wide", kind: "agent" }, { nodeId: "b", kind: "agent" }],
      relationships: [],
    };
    const sizes = { wide: { w: 400, h: 96 } };
    const layout = autoLayout(org, sizes);
    const boxes = [
      { ...layout.wide, ...sizes.wide },
      { ...layout.b, ...NODE_SIZE.agent },
    ];
    const [a, b] = boxes;
    const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    expect(overlap).toBe(false);
  });

  it("is deterministic with overrides too", () => {
    const fleet = BUILTIN_ORGS.find((o) => o.id === "org-default-fleet")!;
    const sizes = { director: { w: 201, h: 107 } };
    expect(autoLayout(fleet, sizes)).toEqual(autoLayout(fleet, sizes));
  });
});
