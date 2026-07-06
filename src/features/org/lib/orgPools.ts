// Org pools (#2199, #2436) — consolidating a swarm of agents into ONE stacked node so large graphs
// stay readable. A POOL is ≥2 positions on the same STACKABLE persona: `pooled`, or worker-role by
// default (explicit `pooled:false` opts out) — the org graph is the SCAFFOLD (director · reviewer ·
// auditor · intake · anchors) plus a stacked engineer slot per worker persona; the planner owns how
// many engineers exist (#2388), so per-engineer wiring detail belongs in the DRILL-IN, not the top
// view. Heterogeneous external wiring no longer prevents stacking (#2436 — it kept Fleet Alpha's own
// engineers from ever collapsing): the collapse UNIONS external edges onto the stack, and the pool's
// `homogeneous` flag records whether members are truly interchangeable (identical external relationship
// signatures) so the UI can mark mixed-wiring stacks. Edges among members (a peer mesh) are internal —
// they show on drill-in. Pure model (React-free) so it's unit-testable, canvas stays thin.
import type { Org, Position, Relationship } from "./org";
import { BUILTIN_PERSONAS, type Persona } from "@/features/personas";

/** Whether a persona's positions stack. An explicit (hydrated) `pooled` always wins — a user who
 *  un-pooled a persona is respected. Otherwise: the PACKAGED built-in's flag (covers a store copy
 *  seeded before the field existed — reconcile #2220 fixes it on next boot, this shows the pool
 *  WITHOUT a restart), and worker-role personas stack BY DEFAULT (#2436 — the engineer slot; the
 *  scaffold roles stay singletons). */
const BUILTIN_POOLED = new Map(BUILTIN_PERSONAS.map((p) => [p.id, !!p.pooled]));
function isStackable(p: Persona): boolean {
  if (p.pooled !== undefined) return p.pooled;
  return (BUILTIN_POOLED.get(p.id) ?? false) || p.role === "worker";
}

export interface Pool {
  /** Synthetic node id for the collapsed group in the parent graph (`pool:<personaId>`). */
  nodeId: string;
  /** The pooled persona every member embodies. */
  personaId: string;
  /** The member position nodeIds (the real positions the pool stands in for). */
  memberNodeIds: string[];
  /** How many instances (= memberNodeIds.length). */
  count: number;
  /** True when every member has the identical external relationship signature (truly interchangeable);
   *  false = mixed wiring, unioned onto the stack — the drill-in shows who has what. */
  homogeneous: boolean;
}

/** The external relationship signature of a position: every edge to a node OUTSIDE `memberSet`, as a
 *  sorted `dir|archetype|counterpart` string. Members with equal signatures are interchangeable; edges
 *  among members (a peer mesh) are excluded. */
function externalSignature(org: Org, nodeId: string, memberSet: Set<string>): string {
  const parts: string[] = [];
  for (const r of org.relationships) {
    if (r.from === nodeId && !memberSet.has(r.to)) parts.push(`out|${r.archetype}|${r.to}`);
    else if (r.to === nodeId && !memberSet.has(r.from)) parts.push(`in|${r.archetype}|${r.from}`);
  }
  return parts.sort().join("~");
}

/** Detect the pools: every STACKABLE persona (pooled, or worker-role — the engineer stack, #2436)
 *  placed ≥2× collapses. Mixed external wiring doesn't block the stack; it only clears `homogeneous`
 *  (e.g. Fleet Alpha's engineers — one overseen by the reviewer, one by the auditor — now stack, with
 *  both oversee edges unioned onto the stack node). Non-worker singletons (the scaffold) never stack.
 *  Deterministic (positions in author order). */
export function detectPools(org: Org, personas: Persona[]): Pool[] {
  const stackable = new Set(personas.filter(isStackable).map((p) => p.id));
  const byPersona = new Map<string, Position[]>();
  for (const p of org.positions) {
    if (p.kind === "agent" && p.personaId && stackable.has(p.personaId)) {
      (byPersona.get(p.personaId) ?? byPersona.set(p.personaId, []).get(p.personaId)!).push(p);
    }
  }
  const pools: Pool[] = [];
  for (const [personaId, members] of byPersona) {
    if (members.length < 2) continue;
    const memberSet = new Set(members.map((m) => m.nodeId));
    const sig0 = externalSignature(org, members[0].nodeId, memberSet);
    const homogeneous = members.every((m) => externalSignature(org, m.nodeId, memberSet) === sig0);
    pools.push({ nodeId: `pool:${personaId}`, personaId, memberNodeIds: members.map((m) => m.nodeId), count: members.length, homogeneous });
  }
  return pools;
}

export interface CollapsedOrg {
  /** The parent graph with each pool's members replaced by one synthetic pool node. */
  org: Org;
  /** Pool metadata keyed by the synthetic pool nodeId — the canvas renders these as stacked cards. */
  poolInfo: Record<string, Pool>;
}

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Collapse an org for the parent view: each pool's members become ONE synthetic pool position at the
 *  members' centroid; external edges are rerouted to the pool node and deduped (by from|to|archetype);
 *  internal edges (both endpoints inside one pool) are dropped. A no-op when there are no pools. */
export function collapseOrg(org: Org, pools: Pool[]): CollapsedOrg {
  if (!pools.length) return { org, poolInfo: {} };
  const memberToPool = new Map<string, Pool>();
  for (const pool of pools) for (const m of pool.memberNodeIds) memberToPool.set(m, pool);

  const positions: Position[] = org.positions.filter((p) => !memberToPool.has(p.nodeId));
  const poolInfo: Record<string, Pool> = {};
  for (const pool of pools) {
    const members = org.positions.filter((p) => memberToPool.get(p.nodeId) === pool);
    positions.push({
      nodeId: pool.nodeId, kind: "agent", personaId: pool.personaId,
      x: Math.round(avg(members.map((m) => m.x ?? 0))), y: Math.round(avg(members.map((m) => m.y ?? 0))),
    });
    poolInfo[pool.nodeId] = pool;
  }

  const remap = (nodeId: string) => memberToPool.get(nodeId)?.nodeId ?? nodeId;
  const seen = new Set<string>();
  const relationships: Relationship[] = [];
  for (const r of org.relationships) {
    const from = remap(r.from), to = remap(r.to);
    if (from === to) continue; // an internal edge, folded away
    const key = `${from}|${to}|${r.archetype}`;
    if (seen.has(key)) continue; // duplicate collapsed edge (N members → one pool edge)
    seen.add(key);
    relationships.push({ ...r, id: `pool-edge:${key}`, from, to });
  }
  return { org: { ...org, positions, relationships }, poolInfo };
}

/** The pool's OWN graph, shown when you drill in: the members, every edge touching a member (the internal
 *  peer mesh + their edges out), and the boundary neighbor nodes those edges reach (context). Positions
 *  are the members' real stored coords, so drilling reads as zooming into that cluster. */
export function poolSubgraph(org: Org, pool: Pool): Org {
  const memberSet = new Set(pool.memberNodeIds);
  const relationships = org.relationships.filter((r) => memberSet.has(r.from) || memberSet.has(r.to));
  const nodeIds = new Set<string>(pool.memberNodeIds);
  for (const r of relationships) { nodeIds.add(r.from); nodeIds.add(r.to); }
  return { ...org, id: `${org.id}::${pool.nodeId}`, positions: org.positions.filter((p) => nodeIds.has(p.nodeId)), relationships };
}
