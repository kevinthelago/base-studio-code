// Glance — the workspace project-network graph model (#2206, epic #2205). Pure (no React/Tauri): turns
// a raw {nodes, edges} project graph into a laid-out, cycle-aware model the canvas renders. Ported from
// the user's "Relationship graph interaction spec" (Glance Network) buildModel — generalized to take
// the graph as input (the real project list feeds it via glanceData.ts) instead of hardcoded data.
//
// The graph is a DEPENDENCY DAG: `from depends on to`. Layers flow left→right by dependency depth
// (a foundational project with no deps sits at layer 0). Mutual pairs (a↔b) are CYCLES — surfaced as
// coordination hazards. This is the DAG/graph layout in the "layout follows data structure" sense
// (#2204): the same layered algorithm the Org designer uses, on a different domain.
import { neighborSpotlight } from "@/shared/lib/graph/spotlight";
import { mutualPairs } from "@/shared/lib/graph/cycles";
import { layerDag } from "@/shared/lib/graph/layers";
import { orderLayers } from "@/shared/lib/graph/order";
import { graphEdge } from "@/shared/lib/graph/edgePath";

export type GRole = "infra" | "service" | "data" | "client";
/** Axis 1 — HEALTH (#2541): the top-left dot colour + the attention/propagation signal. An escalation
 *  ladder that rolls UP the dependency chain (a node shows the worst of itself + everything it depends
 *  on). `idle`/`healthy` never propagate — only `warning`/`error` do. Sourced from the worst unresolved
 *  `bsc errors` FaultLevel; this REPLACES the old separate fault badge. */
export type GHealth = "idle" | "healthy" | "warning" | "error";
/** Axis 2 — ACTIVITY (#2541): the bottom-right lifecycle word — what the project is doing right now.
 *  `planning` surfaces ONLY when the user has re-opened the planner on an already-triaged project (a
 *  re-edit state, never the default). `waiting` = an EXPECTED blocked state (an agent parked for the
 *  user, `bsc-wait`) — calm, not alarming; it lives here, not on the health axis. */
export type GActivity = "planning" | "building" | "waiting" | "review" | "live";
export type GEdgeKind = "api" | "data" | "events";

/** Severity rank for the health rollup — only `warning`/`error` (rank ≥ 1) propagate up dependency
 *  edges; `idle` and `healthy` are both "no problem" (rank 0) and stay put. */
export const HEALTH_RANK: Record<GHealth, number> = { idle: 0, healthy: 0, warning: 1, error: 2 };

/** A project node as supplied by the data adapter (before layout). */
export interface GRawNode {
  id: string;
  /** Display name (defaults to id). */
  slug?: string;
  role: GRole;
  /** Axis 1 — the node's OWN health (before the dependency rollup). #2541. */
  health: GHealth;
  /** Axis 2 — the lifecycle word shown bottom-right. #2541. */
  activity: GActivity;
  /** When health is `warning`/`error`, the short reason (the `Fault.title` that set it) shown in place
   *  of the activity word, so the user sees WHY the dot changed. #2541. */
  reason?: string;
  /** Optional director id (for the node badge / inspector). */
  director?: string;
  /** Display label for the role when the mapped `role` category isn't the real thing — e.g. a fleet
   *  agent's actual session role ("worker" / "reviewer" / "director"), from its persona. The `role`
   *  category still drives the colour; this is the text shown on the card + inspector. */
  roleLabel?: string;
  /** Unresolved runtime-fault count for the project (#2265), from `bsc errors` — surfaced in the
   *  inspector. The count's worst LEVEL drives `health` (#2541); absent/0 ⇒ healthy/idle. */
  faults?: number;
}
/** A dependency edge: `from` depends on `to`, over a contract of `kind`. Optional stable `id` (a
 *  user-drawn project link carries its own; sample/derived edges fall back to a positional id). */
export interface GRawEdge { from: string; to: string; kind: GEdgeKind; id?: string }

export interface GNode extends GRawNode {
  slug: string; layer: number; x: number; y: number;
  /** Health after the up-the-chain rollup (#2541): the worst of this node's own `health` and every node
   *  it (transitively) depends on. This is what the top-left dot renders. */
  rollupHealth: GHealth;
  /** True when `rollupHealth` is worse than the node's OWN `health` — i.e. the node is only lit because
   *  of a downstream dependency. Renders as a MUTED dot (the origin keeps the full/pulsing treatment). */
  healthInherited: boolean;
}
export interface GEdge {
  id: string; from: string; to: string; kind: GEdgeKind;
  /** A hard dependency (api/data) blocks the consumer on a breaking change; events are soft. */
  hard: boolean;
  isCycle: boolean;
  /** SVG path + arrowhead in world coordinates. */
  d: string; arrow: string;
}

export interface GraphModel {
  nodes: GNode[];
  edges: GEdge[];
  /** Mutual-dependency pairs (a↔b) — the coordination hazards. */
  cyclePairs: [string, string][];
  cycleNodeIds: Set<string>;
  worldW: number;
  worldH: number;
}

/** Role → accent colour (drives the node left-border + role chip + legend). */
export const ROLE_COLOR: Record<GRole, string> = {
  infra: "#5b9dff", service: "#4fd6a0", data: "#b98bff", client: "#f2b155",
};
/** Axis 1 — HEALTH → the top-left dot colour + whether it pulses (#2541). Blue = at rest, green =
 *  active & fine, orange = warning, red = error/fatal (pulses; the node to look at). */
export const HEALTH_META: Record<GHealth, { label: string; color: string; pulse: boolean }> = {
  idle: { label: "idle", color: "#5b9dff", pulse: false },
  healthy: { label: "healthy", color: "#4fd6a0", pulse: false },
  warning: { label: "warning", color: "#f2b155", pulse: false },
  error: { label: "error", color: "#f2555f", pulse: true },
};
/** Axis 2 — ACTIVITY → the bottom-right lifecycle word (#2541). Colour is the health axis's job; this
 *  is just the label + whether it animates (a live app / building fleet reads as active). */
export const ACTIVITY_META: Record<GActivity, { label: string; pulse: boolean }> = {
  planning: { label: "planning", pulse: false },
  building: { label: "building", pulse: true },
  waiting: { label: "waiting", pulse: false },
  review: { label: "in review", pulse: false },
  live: { label: "live", pulse: true },
};
/** Edge kind → label · colour · dash · default line width · the contract "surface" blurb. */
export const EDGE_META: Record<GEdgeKind, { label: string; color: string; dash: string; w: number; surface: string }> = {
  api: { label: "API contract", color: "#5b9dff", dash: "", w: 1.8, surface: "REST + gRPC · versioned" },
  data: { label: "data read", color: "#b98bff", dash: "", w: 1.8, surface: "read replica · schema-locked" },
  events: { label: "event stream", color: "#4fd6a0", dash: "6 5", w: 1.7, surface: "events-bus topic · at-least-once" },
};

// Node box + spacing in world (design) coordinates.
export const NW = 186, NH = 66;
const COLGAP = 252, ROWGAP = 102;

/** Bezier path + arrowhead between two node boxes (F depends on T). Cycle back-edges bow to separate the
 *  two directions. Ported from the spec's edgeGeom. */
export function edgeGeom(F: { x: number; y: number; id: string }, T: { x: number; y: number; id: string }, isCycle: boolean): { d: string; arrow: string } {
  // The shared graph line-type (#2222) with SIDE-PORT routing (#2226) — Glance is a layered left→right
  // DAG, so edges leave the right edge / enter the left at the vertical middle for a clean columnar flow
  // (the perimeter-anchor router read messy here). Cycle back-edges bow apart (deterministic sign by id
  // order) so the two directions of a↔b don't overlap.
  const bow = isCycle ? (F.id < T.id ? -46 : 46) : 0;
  const { d, arrow } = graphEdge({ x: F.x, y: F.y, w: NW, h: NH }, { x: T.x, y: T.y, w: NW, h: NH }, { bow, routing: "ports" });
  return { d, arrow };
}

/** The nodes + edges to KEEP lit when something is focused (hovered/selected), so the rest dims. Null
 *  means "nothing focused — everything lit." A node lights itself + its neighbors + connecting edges;
 *  an edge lights its two endpoints; `showCycle` lights every cycle edge + its nodes. Pure. */
export function focusSets(
  model: GraphModel,
  activeNodeId: string | null,
  activeEdgeId: string | null,
  showCycle: boolean,
): { nodes: Set<string>; edges: Set<string> } | null {
  if (activeNodeId) {
    const sp = neighborSpotlight(model.edges, activeNodeId);
    return { nodes: sp.litNodes, edges: sp.litEdges };
  }
  if (activeEdgeId) {
    const e = model.edges.find((x) => x.id === activeEdgeId);
    return e ? { nodes: new Set([e.from, e.to]), edges: new Set([e.id]) } : null;
  }
  if (showCycle) {
    const nodes = new Set<string>(), edges = new Set<string>();
    for (const e of model.edges) if (e.isCycle) { edges.add(e.id); nodes.add(e.from); nodes.add(e.to); }
    return { nodes, edges };
  }
  return null;
}

/**
 * Roll HEALTH up the dependency chain (#2541): each node's effective health is the WORST of its own
 * health and every node it (transitively) depends on — so a foundational service's error surfaces on
 * everything downstream that depends on it. Only `warning`/`error` (rank ≥ 1) propagate; `idle`/`healthy`
 * never override the dependent's own resting state. Cycle-safe (a per-start visited set). Pure.
 *
 * Returns, per node id, the rolled-up `health` and whether it is `inherited` (worse than the node's own
 * health — i.e. lit only because of a dependency, so the dot renders muted, not as the origin).
 */
export function rollUpHealth(
  nodes: { id: string; health: GHealth }[],
  edges: { from: string; to: string }[],
): Map<string, { health: GHealth; inherited: boolean }> {
  const own = new Map(nodes.map((n) => [n.id, n.health]));
  const deps = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) deps.get(e.from)?.push(e.to); // `from depends on to`
  const worstFrom = (start: string): GHealth => {
    let worst = own.get(start) ?? "idle";
    const seen = new Set<string>([start]);
    const stack = [...(deps.get(start) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const h = own.get(id) ?? "idle";
      if (HEALTH_RANK[h] > HEALTH_RANK[worst]) worst = h;
      for (const d of deps.get(id) ?? []) stack.push(d);
    }
    return worst;
  };
  const out = new Map<string, { health: GHealth; inherited: boolean }>();
  for (const n of nodes) {
    const eff = worstFrom(n.id);
    out.set(n.id, { health: eff, inherited: HEALTH_RANK[eff] > HEALTH_RANK[own.get(n.id) ?? "idle"] });
  }
  return out;
}

/** Build the laid-out, cycle-aware graph model from raw nodes + edges. Deterministic. */
export function buildGraph(rawNodes: GRawNode[], rawEdges: GRawEdge[]): GraphModel {
  const nodes: GNode[] = rawNodes.map((n) => ({ ...n, slug: n.slug ?? n.id, layer: 0, x: 0, y: 0, rollupHealth: n.health, healthInherited: false }));
  const byId: Record<string, GNode> = {};
  nodes.forEach((n) => (byId[n.id] = n));

  const edges: GEdge[] = rawEdges
    .filter((e) => byId[e.from] && byId[e.to] && e.from !== e.to)
    .map((e, i) => ({ id: e.id ?? "e" + i, from: e.from, to: e.to, kind: e.kind, hard: e.kind !== "events", isCycle: false, d: "", arrow: "" }));

  // Cycle detection: mutual pairs (a→b AND b→a) — the shared graph-core primitive (#2217).
  const { pairs: cyclePairs, edgeIds: cycleEdge, nodeIds: cycleNodeIds } = mutualPairs(edges);
  edges.forEach((e) => { if (cycleEdge.has(e.id)) e.isCycle = true; });

  // Roll health up the dependency edges (#2541) — every node now carries its effective (rolled) health.
  const rolled = rollUpHealth(nodes, edges);
  nodes.forEach((n) => { const r = rolled.get(n.id)!; n.rollupHealth = r.health; n.healthInherited = r.inherited; });

  // No dependency edges (real projects before a cross-project relationship model exists, #…): a plain
  // GRID so the cards read as a network of peers instead of stacking in one column. Skip the layering.
  if (edges.length === 0) {
    const cols = Math.max(1, Math.round(Math.sqrt(nodes.length)));
    nodes.forEach((n, i) => { n.layer = 0; n.x = 70 + (i % cols) * COLGAP; n.y = 70 + Math.floor(i / cols) * ROWGAP; });
    let mX = 0, mY = 0;
    nodes.forEach((n) => { mX = Math.max(mX, n.x); mY = Math.max(mY, n.y); });
    return { nodes, edges, cyclePairs, cycleNodeIds, worldW: mX + NW + 80, worldH: mY + NH + 90 };
  }

  // Longest-path layering via the shared layerer (#2214). Glance is a DEPENDS-ON DAG (from depends on
  // to → the dependency `to` must sit at a LOWER layer), so we hand `layerDag` the edges REVERSED — its
  // "from → deeper" convention then puts each dependency below its dependent. Cycle (mutual-pair) edges
  // are excluded so the loop can't diverge.
  const reversed = edges.map((e) => ({ id: e.id, from: e.to, to: e.from }));
  const layer = layerDag(nodes.map((n) => n.id), reversed, cycleEdge);
  nodes.forEach((n) => (n.layer = layer[n.id]));

  // Crossing reduction via the shared barycenter orderer (#2418) with glance's tunables: every edge
  // endpoint pulls (both directions, cycle edges included), 6 snapshot sweeps.
  const nb = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  edges.forEach((e) => { nb.get(e.from)!.push(e.to); nb.get(e.to)!.push(e.from); });
  const order = orderLayers(nodes.map((n) => n.id), (id) => layer[id], (id) => nb.get(id)!, { passes: 6, sweep: "snapshot" });

  const maxCount = Math.max(1, ...[...order.values()].map((a) => a.length));
  const Cy = 70 + (maxCount - 1) * ROWGAP / 2;
  for (const [L, arr] of order) {
    arr.forEach((id, i) => {
      byId[id].x = 70 + L * COLGAP;
      byId[id].y = Cy + (i - (arr.length - 1) / 2) * ROWGAP;
    });
  }

  let maxX = 0, maxY = 0;
  nodes.forEach((n) => { maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); });
  const worldW = maxX + NW + 80, worldH = maxY + NH + 90;

  edges.forEach((e) => Object.assign(e, edgeGeom(byId[e.from], byId[e.to], e.isCycle)));

  return { nodes, edges, cyclePairs, cycleNodeIds, worldW, worldH };
}
