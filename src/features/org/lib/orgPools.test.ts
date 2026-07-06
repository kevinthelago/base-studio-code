import { describe, it, expect } from "vitest";
import { detectPools, collapseOrg, poolSubgraph } from "./orgPools";
import type { Org } from "./org";
import type { Persona } from "@/features/personas";

const personas: Persona[] = [
  { id: "p-director", name: "Director", blurb: "", role: "director", startPrompt: "", skills: [] },
  { id: "p-worker", name: "Worker", blurb: "", role: "worker", startPrompt: "", skills: [], pooled: true },
  { id: "p-reviewer", name: "Reviewer", blurb: "", role: "reviewer", startPrompt: "", skills: [] },
];

/** A director managing 3 identical workers (peer mesh among them) — a homogeneous pool. */
const swarm: Org = {
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
    expect(pools[0]).toMatchObject({ nodeId: "pool:p-worker", personaId: "p-worker", count: 3, homogeneous: true });
    expect(pools[0].memberNodeIds.sort()).toEqual(["w1", "w2", "w3"]);
  });

  it("STILL collapses when members have different external relationships, flagged mixed (#2436)", () => {
    // w1 overseen by a reviewer, w2/w3 not — the Fleet-Alpha case (Engineer A→reviewer, B→auditor).
    // Pre-#2436 this blocked the stack, so real orgs' engineers never collapsed; now the engineers
    // stack anyway (the org view is the scaffold + the engineer slot) with `homogeneous:false` — the
    // drill-in shows who has which edge.
    const hetero: Org = {
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
    const org: Org = {
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

  it("respects an explicit un-pool (`pooled:false` beats the worker-role default) and single members", () => {
    const notPooled = personas.map((p) => (p.id === "p-worker" ? { ...p, pooled: false } : p));
    expect(detectPools(swarm, notPooled)).toHaveLength(0);
    // one worker only → no pool even when pooled
    const single: Org = { ...swarm, positions: swarm.positions.slice(0, 2), relationships: [swarm.relationships[0]] };
    expect(detectPools(single, personas)).toHaveLength(0);
  });

  it("never stacks the scaffold: a non-worker persona placed twice stays two singletons", () => {
    // Two reviewer positions (not pooled, not worker-role) — leadership/quality roles are the
    // scaffold and must stay individually visible.
    const org: Org = {
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
