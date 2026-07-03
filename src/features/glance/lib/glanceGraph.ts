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

export type GRole = "infra" | "service" | "data" | "client";
export type GStatus = "idle" | "planning" | "building" | "review" | "blocked" | "done";
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
}
/** A dependency edge: `from` depends on `to`, over a contract of `kind`. */
export interface GRawEdge { from: string; to: string; kind: GEdgeKind }

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
  const fRight = F.x < T.x;
  const fx = F.x + (fRight ? NW : 0), fy = F.y + NH / 2;
  const tLeftPort = T.x >= F.x;
  const tx = T.x + (tLeftPort ? 0 : NW), ty = T.y + NH / 2;
  const k = Math.max(46, Math.abs(tx - fx) * 0.5);
  const bow = isCycle ? (F.id < T.id ? -46 : 46) : 0;
  const c1x = fx + (fRight ? k : -k), c2x = tx + (tLeftPort ? -k : k);
  const c1y = fy + bow, c2y = ty + bow;
  const d = `M ${fx} ${fy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`;
  const ang = Math.atan2(ty - c2y, tx - c2x);
  const AL = 9, AW = 5.2;
  const bx = tx - Math.cos(ang) * AL, by = ty - Math.sin(ang) * AL;
  const nx = -Math.sin(ang), ny = Math.cos(ang);
  const arrow = `M ${tx} ${ty} L ${bx + nx * AW} ${by + ny * AW} L ${bx - nx * AW} ${by - ny * AW} Z`;
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
    .map((e, i) => ({ id: "e" + i, from: e.from, to: e.to, kind: e.kind, hard: e.kind !== "events", isCycle: false, d: "", arrow: "" }));

  // Cycle detection: mutual pairs (a→b AND b→a) — the shared graph-core primitive (#2217).
  const { pairs: cyclePairs, edgeIds: cycleEdge, nodeIds: cycleNodeIds } = mutualPairs(edges);
  edges.forEach((e) => { if (cycleEdge.has(e.id)) e.isCycle = true; });

  // Longest-path layering (skip cycle edges so the loop doesn't diverge): layer[from] = max(layer[to]+1).
  const layer: Record<string, number> = {};
  nodes.forEach((n) => (layer[n.id] = 0));
  for (let iter = 0; iter < nodes.length + 2; iter++) {
    let changed = false;
    edges.forEach((e) => {
      if (cycleEdge.has(e.id)) return;
      if (layer[e.from] < layer[e.to] + 1) { layer[e.from] = layer[e.to] + 1; changed = true; }
    });
    if (!changed) break;
  }
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
