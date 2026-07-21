import { describe, it, expect } from "vitest";
import { detectPools, collapseOrg, poolSubgraph, poolLayoutSizes, applyPoolLayout, organizeDrilledPool, POOL_STACK_OFFSET } from "./orgPools";
import { autoLayout, AUTO_ROW, NODE_SIZE } from "./orgLayout";
import type { Team } from "./team";
import type { Persona } from "@/features/personas";

const personas: Persona[] = [
  { id: "p-director", name: "Director", blurb: "", role: "director", startPrompt: "", skills: [] },
  { id: "p-worker", name: "Worker", blurb: "", role: "worker", startPrompt: "", skills: [], pooled: true },
  { id: "p-reviewer", name: "Reviewer", blurb: "", role: "reviewer", startPrompt: "", skills: [] },
];

/** A director managing 3 identical workers (peer mesh among them) — a homogeneous pool. */
const swarm: Team = {
  id: "swarm", name: "Swarm",
  positions: [
    { nodeId: "director", kind: "agent", personaId: "p-director", x: 400, y: 40 },
    { nodeId: "w1", kind: "agent", personaId: "p-worker", x: 100, y: 300 },
    { nodeId: "w2", kind: "agent", personaId: "p-worker", x: 400, y: 300 },
    { nodeId: "w3", kind: "agent", personaId: "p-worker", x: 700, y: 300 },
  ],
  relationships: [
    { id: "m1", archetype: "manages", from: "director", to: "w1" },
    { id: "m2", archetype: "manages", from: "director", to: "w2" },
    { id: "m3", archetype: "manages", from: "director", to: "w3" },
    { id: "p12", archetype: "peers", from: "w1", to: "w2" },
    { id: "p23", archetype: "peers", from: "w2", to: "w3" },
  ],
};

describe("detectPools (#2199)", () => {
  it("collapses a homogeneous swarm into one pool", () => {
    const pools = detectPools(swarm, personas);
    expect(pools).toHaveLength(1);
    // A worker pool is planner-sized (#3143): the card shows no ×N.
    expect(pools[0]).toMatchObject({ nodeId: "pool:p-worker", personaId: "p-worker", count: 3, homogeneous: true, plannerSized: true });
    expect(pools[0].memberNodeIds.sort()).toEqual(["w1", "w2", "w3"]);
  });

  it("STILL collapses when members have different external relationships, flagged mixed (#2436)", () => {
    // w1 overseen by a reviewer, w2/w3 not — the Fleet-Alpha case (Engineer A→reviewer, B→auditor).
    // Pre-#2436 this blocked the stack, so real orgs' engineers never collapsed; now the engineers
    // stack anyway (the org view is the scaffold + the engineer slot) with `homogeneous:false` — the
    // drill-in shows who has which edge.
    const hetero: Team = {
      ...swarm,
      positions: [...swarm.positions, { nodeId: "reviewer", kind: "agent", personaId: "p-reviewer", x: 0, y: 0 }],
      relationships: [...swarm.relationships, { id: "ov", archetype: "oversees", from: "reviewer", to: "w1" }],
    };
    const pools = detectPools(hetero, personas);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ nodeId: "pool:p-worker", count: 3, homogeneous: false });
  });

  it("stacks a worker-role persona BY DEFAULT — no `pooled` flag needed (#2436)", () => {
    // A user-authored engineer persona (role worker, `pooled` unset) stacks: the engineer slot is
    // the scalable one; the planner owns how many engineers exist (#2388).
    const custom = personas.map((p) => (p.id === "p-worker" ? { ...p, pooled: undefined } : p));
    const pools = detectPools(swarm, custom);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ nodeId: "pool:p-worker", count: 3 });
  });

  it("falls back to the packaged pooled flag when the store copy predates the field", () => {
    // A store persona-worker seeded before `pooled` existed (no field). detectPools must still treat it
    // as pooled from the built-in — so the pool shows without an app restart.
    const stale: Persona[] = [
      { id: "persona-director", name: "Director", blurb: "", role: "director", startPrompt: "", skills: [] },
      { id: "persona-worker", name: "Worker", blurb: "", role: "worker", startPrompt: "", skills: [] }, // no `pooled`
    ];
    const org: Team = {
      id: "s", name: "s",
      positions: [
        { nodeId: "director", kind: "agent", personaId: "persona-director" },
        { nodeId: "w1", kind: "agent", personaId: "persona-worker" },
        { nodeId: "w2", kind: "agent", personaId: "persona-worker" },
      ],
      relationships: [
        { id: "m1", archetype: "manages", from: "director", to: "w1" },
        { id: "m2", archetype: "manages", from: "director", to: "w2" },
      ],
    };
    expect(detectPools(org, stale)).toHaveLength(1);
  });

  it("respects an explicit un-pool (`pooled:false` beats the worker-role default)", () => {
    const notPooled = personas.map((p) => (p.id === "p-worker" ? { ...p, pooled: false } : p));
    expect(detectPools(swarm, notPooled)).toHaveLength(0);
  });

  it("a SINGLE planner-sized (worker) slot still collapses to a countless stack (#3143)", () => {
    // The planner owns how many engineers exist (#2388), so ONE engineer node is a planner-sized SLOT,
    // not a lone agent — it collapses to a stack whose card shows no ×N (Fleet Alpha's engineer, #3143).
    const single: Team = { ...swarm, positions: swarm.positions.slice(0, 2), relationships: [swarm.relationships[0]] };
    const pools = detectPools(single, personas);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ nodeId: "pool:p-worker", count: 1, plannerSized: true });
  });

  it("a NON-worker pooled persona still needs a real swarm (≥2) to collapse (#3143 keeps the ≥2 floor)", () => {
    // Only worker-role slots are planner-sized; a pooled non-worker with one member stays a singleton.
    const pooledReviewer: Persona[] = personas.map((p) => (p.id === "p-reviewer" ? { ...p, pooled: true } : p));
    const one: Team = { id: "o", name: "o", positions: [{ nodeId: "r1", kind: "agent", personaId: "p-reviewer" }], relationships: [] };
    expect(detectPools(one, pooledReviewer)).toHaveLength(0);
    const two: Team = { ...one, positions: [{ nodeId: "r1", kind: "agent", personaId: "p-reviewer" }, { nodeId: "r2", kind: "agent", personaId: "p-reviewer" }] };
    expect(detectPools(two, pooledReviewer)).toMatchObject([{ count: 2, plannerSized: false }]);
  });

  it("never stacks the scaffold: a non-worker persona placed twice stays two singletons", () => {
    // Two reviewer positions (not pooled, not worker-role) — leadership/quality roles are the
    // scaffold and must stay individually visible.
    const org: Team = {
      id: "s", name: "s",
      positions: [
        { nodeId: "r1", kind: "agent", personaId: "p-reviewer" },
        { nodeId: "r2", kind: "agent", personaId: "p-reviewer" },
      ],
      relationships: [],
    };
    expect(detectPools(org, personas)).toHaveLength(0);
  });
});

describe("collapseOrg (#2199)", () => {
  it("replaces members with one pool node, reroutes + dedupes external edges, drops internal ones", () => {
    const pools = detectPools(swarm, personas);
    const { org, poolInfo } = collapseOrg(swarm, pools);
    // members gone, pool node present
    expect(org.positions.map((p) => p.nodeId).sort()).toEqual(["director", "pool:p-worker"]);
    expect(poolInfo["pool:p-worker"].count).toBe(3);
    // the 3 director→worker edges dedupe to ONE director→pool edge; the two peer edges (internal) vanish
    expect(org.relationships).toHaveLength(1);
    expect(org.relationships[0]).toMatchObject({ from: "director", to: "pool:p-worker", archetype: "manages" });
    // pool node sits at the members' centroid
    expect(org.positions.find((p) => p.nodeId === "pool:p-worker")).toMatchObject({ x: 400, y: 300 });
  });

  it("is a no-op with no pools", () => {
    const { org, poolInfo } = collapseOrg(swarm, []);
    expect(org).toBe(swarm);
    expect(poolInfo).toEqual({});
  });
});

describe("poolSubgraph (#2199)", () => {
  it("keeps the members + their edges + boundary neighbors", () => {
    const [pool] = detectPools(swarm, personas);
    const sub = poolSubgraph(swarm, pool);
    // members + the director (boundary neighbor) are present
    expect(sub.positions.map((p) => p.nodeId).sort()).toEqual(["director", "w1", "w2", "w3"]);
    // internal peer edges + the manages edges are all retained (they each touch a member)
    expect(sub.relationships.map((r) => r.id).sort()).toEqual(["m1", "m2", "m3", "p12", "p23"]);
  });
});

// ── Auto-organize over pools (#2451) ─────────────────────────────────────────

describe("poolLayoutSizes (#2451)", () => {
  it("gives each pool node the stacked card's footprint — agent card + shadow-stack overhang", () => {
    const pools = detectPools(swarm, personas);
    const sizes = poolLayoutSizes(pools);
    expect(sizes["pool:p-worker"]).toEqual({
      w: NODE_SIZE.agent.w + POOL_STACK_OFFSET,
      h: NODE_SIZE.agent.h + POOL_STACK_OFFSET,
    });
    expect(Object.keys(sizes)).toEqual(["pool:p-worker"]);
  });
});

describe("auto-organize lays out the COLLAPSED graph (#2451)", () => {
  /** The #2436 mixed-wiring shape: one engineer managed by the director, the other overseen by a
   *  reviewer the director manages — the members land on DIFFERENT hierarchy layers in the full org,
   *  so the old full-org layout put their centroid (= the rendered stack) BETWEEN rows. */
  const mixed: Team = {
    id: "mixed", name: "Mixed",
    positions: [
      { nodeId: "director", kind: "agent", personaId: "p-director", x: 400, y: 40 },
      { nodeId: "reviewer", kind: "agent", personaId: "p-reviewer", x: 100, y: 240 },
      { nodeId: "e1", kind: "agent", personaId: "p-worker", x: 300, y: 240 },
      { nodeId: "e2", kind: "agent", personaId: "p-worker", x: 500, y: 440 },
    ],
    relationships: [
      { id: "m-rev", archetype: "manages", from: "director", to: "reviewer" },
      { id: "m-e1", archetype: "manages", from: "director", to: "e1" },
      { id: "ov-e2", archetype: "oversees", from: "reviewer", to: "e2" },
    ],
  };
  const pools = detectPools(mixed, personas);
  const collapsed = collapseOrg(mixed, pools);
  const sizes = poolLayoutSizes(pools);
  /** Center-y of a laid-out node (`autoLayout` returns top-left boxes). */
  const centerY = (l: Record<string, { x: number; y: number }>, id: string, h: number) => l[id].y + h / 2;

  it("regression (#2436 shape): the pool node sits ON a hierarchy row of the collapsed graph", () => {
    const layout = autoLayout(collapsed.org, sizes);
    // In the collapsed graph the pool's layer is max(director, reviewer) + 1 = 2 — two full rows
    // below the director, never between rows (each top-left rounds by ≤ .5, hence the ±1 slack).
    const dy = centerY(layout, "pool:p-worker", sizes["pool:p-worker"].h) - centerY(layout, "director", NODE_SIZE.agent.h);
    expect(Math.abs(dy - 2 * AUTO_ROW)).toBeLessThanOrEqual(1);
  });

  it("documents the OLD bug: the full-org layout put the members' centroid BETWEEN rows", () => {
    // e1 layers at 1, e2 at 2 → the centroid (where the stack renders) is 1.5 rows below the
    // director: on no row. This is the shape the collapsed-graph layout above fixes.
    const layout = autoLayout(mixed);
    const centroidY = (centerY(layout, "e1", NODE_SIZE.agent.h) + centerY(layout, "e2", NODE_SIZE.agent.h)) / 2;
    const dy = centroidY - centerY(layout, "director", NODE_SIZE.agent.h);
    expect(Math.abs(dy - 1.5 * AUTO_ROW)).toBeLessThanOrEqual(1);
  });

  it("end-to-end write-back: after applyPoolLayout, the re-collapsed pool renders at its laid-out spot", () => {
    const layout = autoLayout(collapsed.org, sizes);
    const positions = applyPoolLayout(mixed, pools, layout);
    const re = collapseOrg({ ...mixed, positions }, pools);
    const pool = re.org.positions.find((p) => p.nodeId === "pool:p-worker")!;
    // collapseOrg renders the stack at the members' centroid — the translation put it on the target
    // (within 1 for the two independent roundings).
    expect(Math.abs((pool.x ?? 0) - layout["pool:p-worker"].x)).toBeLessThanOrEqual(1);
    expect(Math.abs((pool.y ?? 0) - layout["pool:p-worker"].y)).toBeLessThanOrEqual(1);
  });
});

describe("applyPoolLayout (#2451)", () => {
  const pools = detectPools(swarm, personas);

  it("applies non-pooled spots directly and translates the member cluster to the pool spot", () => {
    const layout = { director: { x: 10, y: 20 }, "pool:p-worker": { x: 500, y: 480 } };
    const positions = applyPoolLayout(swarm, pools, layout);
    const at = (id: string) => positions.find((p) => p.nodeId === id)!;
    expect(at("director")).toMatchObject({ x: 10, y: 20 });
    // members: (100,300) (400,300) (700,300), centroid (400,300) → one shared delta (+100,+180)
    expect(at("w1")).toMatchObject({ x: 200, y: 480 });
    expect(at("w2")).toMatchObject({ x: 500, y: 480 });
    expect(at("w3")).toMatchObject({ x: 800, y: 480 });
  });

  it("preserves the members' relative offsets EXACTLY, even through a fractional centroid delta", () => {
    // w3 nudged to 701 → member centroid x = 400.333… → a fractional shared delta. Every member
    // rounds with the same fractional part, so pairwise offsets survive the rounding untouched
    // (the #2439 drill-in contract).
    const org: Team = { ...swarm, positions: swarm.positions.map((p) => (p.nodeId === "w3" ? { ...p, x: 701, y: 340 } : p)) };
    const layout = { director: { x: 0, y: 0 }, "pool:p-worker": { x: 511, y: 487 } };
    const positions = applyPoolLayout(org, detectPools(org, personas), layout);
    const at = (id: string) => positions.find((p) => p.nodeId === id)!;
    expect(at("w2").x! - at("w1").x!).toBe(300);
    expect(at("w3").x! - at("w2").x!).toBe(301);
    expect(at("w3").y! - at("w1").y!).toBe(40);
    // and the centroid landed on the pool's spot (± the shared rounding)
    const cx = (at("w1").x! + at("w2").x! + at("w3").x!) / 3;
    expect(Math.abs(cx - 511)).toBeLessThanOrEqual(1);
  });

  it("spreads a degenerate (all-unplaced) cluster deterministically around the pool spot", () => {
    const org: Team = { ...swarm, positions: swarm.positions.map((p) => ({ ...p, x: undefined, y: undefined })) };
    const layout = { director: { x: 60, y: 48 }, "pool:p-worker": { x: 300, y: 260 } };
    const positions = applyPoolLayout(org, detectPools(org, personas), layout);
    const members = positions.filter((p) => p.personaId === "p-worker");
    // no two members coincide (a pure translation would have kept them stacked at one point)
    const spots = new Set(members.map((m) => `${m.x},${m.y}`));
    expect(spots.size).toBe(members.length);
    // the centroid still lands on the pool's laid-out spot
    expect(Math.abs(members.reduce((s, m) => s + (m.x ?? 0), 0) / members.length - 300)).toBeLessThanOrEqual(1);
    expect(Math.abs(members.reduce((s, m) => s + (m.y ?? 0), 0) / members.length - 260)).toBeLessThanOrEqual(1);
    // deterministic — a re-run reproduces the exact same spread
    expect(applyPoolLayout(org, detectPools(org, personas), layout)).toEqual(positions);
  });

  it("leaves a pool's members untouched when the layout has no spot for it", () => {
    const positions = applyPoolLayout(swarm, pools, { director: { x: 1, y: 2 } });
    expect(positions.find((p) => p.nodeId === "w1")).toMatchObject({ x: 100, y: 300 });
    expect(positions.find((p) => p.nodeId === "director")).toMatchObject({ x: 1, y: 2 });
  });
});

describe("organizeDrilledPool (#2451)", () => {
  const [pool] = detectPools(swarm, personas);

  it("never moves boundary/parent nodes — only the members re-arrange", () => {
    const positions = organizeDrilledPool(swarm, pool);
    // the director (a boundary neighbor shown as drill context) keeps its exact stored spot
    expect(positions.find((p) => p.nodeId === "director")).toMatchObject({ x: 400, y: 40 });
    // the members got fresh finite coords
    for (const id of pool.memberNodeIds) {
      const m = positions.find((p) => p.nodeId === id)!;
      expect(Number.isFinite(m.x)).toBe(true);
      expect(Number.isFinite(m.y)).toBe(true);
    }
  });

  it("anchors the re-laid-out cluster at the members' previous centroid (context doesn't jump)", () => {
    const positions = organizeDrilledPool(swarm, pool);
    const members = positions.filter((p) => pool.memberNodeIds.includes(p.nodeId));
    // previous centroid: ((100+400+700)/3, 300) = (400, 300)
    expect(Math.abs(members.reduce((s, m) => s + (m.x ?? 0), 0) / members.length - 400)).toBeLessThanOrEqual(1);
    expect(Math.abs(members.reduce((s, m) => s + (m.y ?? 0), 0) / members.length - 300)).toBeLessThanOrEqual(1);
    // deterministic
    expect(organizeDrilledPool(swarm, pool)).toEqual(positions);
  });
});
