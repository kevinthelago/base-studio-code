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
import { autoLayout, NODE_SIZE } from "./orgLayout";
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

// ── Auto-organize over pools (#2451) ─────────────────────────────────────────
// `autoLayout(org)` on the FULL org laid out every pooled member as an individual node while the
// canvas renders the COLLAPSED org — so the pool card (drawn at the members' centroid) landed at the
// row center, or BETWEEN hierarchy rows when mixed wiring (#2436) put members on different layers,
// and no collision pass ever saw the stacked card. The fix: lay out the graph the user is LOOKING AT
// (the collapsed org, with the pool node carrying its real stacked-card footprint), then write back
// through the pool abstraction — translate each member cluster so its centroid is the pool's
// laid-out spot, preserving the members' relative arrangement for drill-in (#2439).

/** The stacked card's shadow-card offset (design px) — OrgCanvas renders the outermost shadow card
 *  at `translate(POOL_STACK_OFFSET, POOL_STACK_OFFSET)`, so a pool's true render footprint is the
 *  agent card plus this overhang in each axis. The layout must see THAT size (via `poolLayoutSizes`)
 *  so collision spaces the stack like the card the user actually sees. */
export const POOL_STACK_OFFSET = 11;

/** Per-node size overrides for `autoLayout` over a COLLAPSED org: each synthetic pool node takes the
 *  stacked card's real footprint (agent card + shadow-stack overhang). */
export function poolLayoutSizes(pools: Pool[]): Record<string, { w: number; h: number }> {
  const size = { w: NODE_SIZE.agent.w + POOL_STACK_OFFSET, h: NODE_SIZE.agent.h + POOL_STACK_OFFSET };
  return Object.fromEntries(pools.map((p) => [p.nodeId, size]));
}

// The degenerate-cluster spread: when every member sits on the SAME point (typically all unplaced at
// 0,0), a pure translation would keep them exactly coincident — so instead they get a small
// deterministic grid around the pool's laid-out spot (centroid still lands ON the spot). Steps are
// deliberately smaller than a card: the parent view shows one stack either way, and the drill-in's
// own auto-organize is the real untangler.
const SPREAD_X = 60;
const SPREAD_Y = 44;

/** Write a collapsed-org layout back onto the FULL org's positions (#2451). Non-pooled nodes take
 *  their laid-out spot directly. Each pool's members are TRANSLATED by one shared delta so their
 *  centroid — where the stacked card renders (`collapseOrg`) — equals the pool node's laid-out spot,
 *  preserving the members' relative arrangement (the #2439 drill-in contract). A coincident/unplaced
 *  member cluster gets a small deterministic spread around the spot instead (see above). Pure +
 *  deterministic; returns a fresh positions array. */
export function applyPoolLayout(org: Org, pools: Pool[], layout: Record<string, { x: number; y: number }>): Position[] {
  const moved = new Map<string, { x: number; y: number }>();
  for (const pool of pools) {
    const target = layout[pool.nodeId];
    if (!target) continue; // pool absent from the laid-out graph — leave its members untouched
    const members = org.positions.filter((p) => pool.memberNodeIds.includes(p.nodeId));
    const xs = members.map((m) => m.x ?? 0);
    const ys = members.map((m) => m.y ?? 0);
    if (xs.every((x) => x === xs[0]) && ys.every((y) => y === ys[0])) {
      // Degenerate: all members coincident — deterministic compact grid, centered so centroid = target.
      const cols = Math.ceil(Math.sqrt(members.length));
      const offs = members.map((_, i) => ({ x: (i % cols) * SPREAD_X, y: Math.floor(i / cols) * SPREAD_Y }));
      const cx = avg(offs.map((o) => o.x)), cy = avg(offs.map((o) => o.y));
      members.forEach((m, i) => moved.set(m.nodeId, { x: Math.round(target.x + offs[i].x - cx), y: Math.round(target.y + offs[i].y - cy) }));
    } else {
      // One shared delta for the whole cluster (integer inputs keep relative offsets EXACT through
      // the rounding, since every member rounds with the same fractional part).
      const dx = target.x - avg(xs), dy = target.y - avg(ys);
      members.forEach((m, i) => moved.set(m.nodeId, { x: Math.round(xs[i] + dx), y: Math.round(ys[i] + dy) }));
    }
  }
  return org.positions.map((p) => {
    const next = moved.get(p.nodeId) ?? layout[p.nodeId];
    return next ? { ...p, ...next } : p;
  });
}

/** Auto-organize INSIDE a drilled pool (#2451): re-lay out ONLY the members (over their internal peer
 *  mesh), then anchor the new cluster at the members' previous centroid so the surrounding context
 *  doesn't jump. Boundary neighbors belong to the PARENT view and are never moved — chosen over
 *  layering members against pinned boundary nodes because the members are one persona (a flat
 *  row/grid near their old spot reads well) and "context stays put" is the simplest honest contract
 *  from inside a drill. Returns the full org's positions with only the members changed. */
export function organizeDrilledPool(org: Org, pool: Pool): Position[] {
  const memberSet = new Set(pool.memberNodeIds);
  const members = org.positions.filter((p) => memberSet.has(p.nodeId));
  if (!members.length) return org.positions;
  const sub: Org = {
    ...org,
    positions: members,
    relationships: org.relationships.filter((r) => memberSet.has(r.from) && memberSet.has(r.to)),
  };
  const layout = autoLayout(sub);
  const dx = avg(members.map((m) => m.x ?? 0)) - avg(members.map((m) => layout[m.nodeId].x));
  const dy = avg(members.map((m) => m.y ?? 0)) - avg(members.map((m) => layout[m.nodeId].y));
  const moved = new Map(members.map((m) => [m.nodeId, { x: Math.round(layout[m.nodeId].x + dx), y: Math.round(layout[m.nodeId].y + dy) }]));
  return org.positions.map((p) => {
    const next = moved.get(p.nodeId);
    return next ? { ...p, ...next } : p;
  });
}
