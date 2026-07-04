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
import { graphEdge } from "@/shared/lib/graph/edgePath";

export type GRole = "infra" | "service" | "data" | "client";
export type GStatus = "idle" | "planning" | "building" | "review" | "blocked" | "done" | "live";
export type GEdgeKind = "api" | "data" | "events";

/** A project node as supplied by the data adapter (before layout). */
export interface GRawNode {
  id: string;
  /** Display name (defaults to id). */
  slug?: string;
  role: GRole;
  status: GStatus;
  /** Optional director id (for the node badge / inspector). */
  director?: string;
  /** Display label for the role when the mapped `role` category isn't the real thing — e.g. a fleet
   *  agent's actual session role ("worker" / "reviewer" / "director"), from its persona. The `role`
   *  category still drives the colour; this is the text shown on the card + inspector. */
  roleLabel?: string;
}
/** A dependency edge: `from` depends on `to`, over a contract of `kind`. Optional stable `id` (a
 *  user-drawn project link carries its own; sample/derived edges fall back to a positional id). */
export interface GRawEdge { from: string; to: string; kind: GEdgeKind; id?: string }

export interface GNode extends GRawNode { slug: string; layer: number; x: number; y: number }
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
/** Status → colour + whether it pulses (live activity). */
export const STATUS_META: Record<GStatus, { label: string; color: string; pulse: boolean }> = {
  idle: { label: "idle", color: "#6b7280", pulse: false },
  planning: { label: "planning", color: "#5b9dff", pulse: false },
  building: { label: "building", color: "#4fd6a0", pulse: true },
  review: { label: "in review", color: "#f2b155", pulse: false },
  blocked: { label: "blocked", color: "#f2555f", pulse: true },
  done: { label: "shipped", color: "#3f7d63", pulse: false },
  // The app itself is detected RUNNING (a local dev server or a cloud deployment) — a bright pulsing green.
  live: { label: "live", color: "#3fe08f", pulse: true },
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

/** Build the laid-out, cycle-aware graph model from raw nodes + edges. Deterministic. */
export function buildGraph(rawNodes: GRawNode[], rawEdges: GRawEdge[]): GraphModel {
  const nodes: GNode[] = rawNodes.map((n) => ({ ...n, slug: n.slug ?? n.id, layer: 0, x: 0, y: 0 }));
  const byId: Record<string, GNode> = {};
  nodes.forEach((n) => (byId[n.id] = n));

  const edges: GEdge[] = rawEdges
    .filter((e) => byId[e.from] && byId[e.to] && e.from !== e.to)
    .map((e, i) => ({ id: e.id ?? "e" + i, from: e.from, to: e.to, kind: e.kind, hard: e.kind !== "events", isCycle: false, d: "", arrow: "" }));

  // Cycle detection: mutual pairs (a→b AND b→a) — the shared graph-core primitive (#2217).
  const { pairs: cyclePairs, edgeIds: cycleEdge, nodeIds: cycleNodeIds } = mutualPairs(edges);
  edges.forEach((e) => { if (cycleEdge.has(e.id)) e.isCycle = true; });

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

  // Group by layer + barycenter ordering to cut crossings.
  const byLayer: Record<number, GNode[]> = {};
  nodes.forEach((n) => (byLayer[n.layer] = byLayer[n.layer] || []).push(n));
  const orderIdx: Record<string, number> = {};
  Object.values(byLayer).forEach((arr) => arr.forEach((n, i) => (orderIdx[n.id] = i)));
  for (let pass = 0; pass < 6; pass++) {
    const bary: Record<string, number> = {};
    nodes.forEach((n) => {
      const nb: number[] = [];
      edges.forEach((e) => { if (e.from === n.id) nb.push(orderIdx[e.to]); if (e.to === n.id) nb.push(orderIdx[e.from]); });
      bary[n.id] = nb.length ? nb.reduce((a, b) => a + b, 0) / nb.length : orderIdx[n.id];
    });
    Object.values(byLayer).forEach((arr) => {
      arr.sort((a, b) => (bary[a.id] - bary[b.id]) || (orderIdx[a.id] - orderIdx[b.id]));
      arr.forEach((n, i) => (orderIdx[n.id] = i));
    });
  }

  const maxCount = Math.max(1, ...Object.values(byLayer).map((a) => a.length));
  const Cy = 70 + (maxCount - 1) * ROWGAP / 2;
  Object.entries(byLayer).forEach(([L, arr]) => {
    arr.forEach((n, i) => {
      n.x = 70 + Number(L) * COLGAP;
      n.y = Cy + (i - (arr.length - 1) / 2) * ROWGAP;
    });
  });

  let maxX = 0, maxY = 0;
  nodes.forEach((n) => { maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); });
  const worldW = maxX + NW + 80, worldH = maxY + NH + 90;

  edges.forEach((e) => Object.assign(e, edgeGeom(byId[e.from], byId[e.to], e.isCycle)));

  return { nodes, edges, cyclePairs, cycleNodeIds, worldW, worldH };
}
