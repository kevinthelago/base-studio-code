// Agent-relationship graph (#…) — the typed coordination graph over the fleet's
// streams: who produces which artifact, who consumes it, and how each relationship
// is coordinated (director-relayed vs direct peer). Pure (no React/Tauri) so the
// layering + cycle detection are unit-testable; the visualization lives in
// RelationshipGraphView.tsx and the authoring controls in the Structure/Permissions
// focused panes. Mirrors the design prototype (design/bsc · model()).
import { neighborSpotlight } from "@/shared/lib/graph/spotlight";
import { findBackEdges } from "@/shared/lib/graph/cycles";
import { layerDag } from "@/shared/lib/graph/layers";

/** Fleet coordination topology. `director` = hub-and-spoke (every edge routes through
 *  the director), `peer` = mesh (every edge is a direct handoff), `hybrid` = per-edge. */
export type Topology = "director" | "peer" | "hybrid";

/** Relationship kind. The "ordering" kinds (handoff/blocking/sequence/review) impose a
 *  build order and participate in cycle detection + layering; the rest are annotations. */
export type EdgeKind = "handoff" | "blocking" | "sequence" | "review" | "notify" | "mutex" | "shared";

/** Hardness of a relationship: hard wait · proceed-against-a-stub · fire-and-forget. */
export type Hardness = "blocking" | "soft" | "notify";

/** How a relationship is coordinated. */
export type Via = "director" | "direct";

export type ArtifactKind = "schema" | "contract" | "types" | "tokens" | "fixture" | "other";

/** A produced contract/schema/types another stream consumes — the coord `contract:<id>` ref. */
export interface RelationshipArtifact {
  id: string;
  name: string;
  kind: ArtifactKind;
  producer: string;           // stream id
  consumers: string[];        // stream ids
  status?: "pending" | "ready";
}

/** A typed relationship edge between two streams. */
export interface AgentRelationship {
  id: string;
  from: string;               // upstream stream id
  to: string;                 // downstream stream id
  kind: EdgeKind;
  artifact?: string;          // RelationshipArtifact.id for handoff/shared
  hardness: Hardness;
  via: Via;
  note?: string;
}

/** Minimal stream shape the graph needs (a projection of AgentStream). */
export interface RelStream {
  id: string;
  role?: string;
  repo?: string;
  owns?: string[];
}

/** An edge with its effective `via` resolved against the fleet topology. */
export interface ResolvedEdge extends AgentRelationship { viaEff: Via }

export interface RelationshipGraph {
  streams: RelStream[];
  artifacts: RelationshipArtifact[];
  edges: ResolvedEdge[];
  /** Stream ids, in declaration order. */
  sids: string[];
  /** Topological layer per stream id (0 = a source). Back-edges are excluded so a cycle
   *  doesn't blow up the layering. */
  layerOf: Record<string, number>;
  /** True when an ordering-edge cycle exists (a coordination deadlock). */
  hasCycle: boolean;
  /** Ids of the edges that close a cycle (the back-edges) — rendered red + block the gate. */
  cycleEdgeIds: Set<string>;
}

/** Ordering kinds — they impose build order, so they drive cycle detection + layering. */
const ORDERING: ReadonlySet<EdgeKind> = new Set<EdgeKind>(["handoff", "blocking", "sequence", "review"]);

/** Resolve an edge's effective `via` against the topology (director/peer force it; hybrid keeps it). */
export function effectiveVia(topology: Topology, via: Via): Via {
  return topology === "director" ? "director" : topology === "peer" ? "direct" : via;
}

/**
 * Build the relationship graph from the fleet's streams, declared artifacts, and edges,
 * under a coordination topology. Detects ordering cycles (DFS back-edges) and assigns
 * topological layers (shared longest-path layerer, excluding back-edges so a cycle can't
 * explode the layout).
 */
export function buildRelationshipGraph(
  streams: RelStream[],
  artifacts: RelationshipArtifact[],
  edges: AgentRelationship[],
  topology: Topology,
): RelationshipGraph {
  const sids = streams.map((s) => s.id);
  const resolved: ResolvedEdge[] = edges.map((e) => ({ ...e, viaEff: effectiveVia(topology, e.via) }));

  // ── cycle detection FIRST (DFS back-edges over ordering edges) — shared graph-core primitive (#2217) ──
  const { backEdgeIds: cycleEdgeIds, hasCycle } = findBackEdges(sids, resolved.filter((e) => ORDERING.has(e.kind)));

  // ── layering over ordering edges, EXCLUDING back-edges (keeps it a DAG) — shared layerer (#2214) ──
  const layerOf = layerDag(sids, resolved.filter((e) => ORDERING.has(e.kind)), cycleEdgeIds);

  return { streams, artifacts, edges: resolved, sids, layerOf, hasCycle, cycleEdgeIds };
}

// ── display metadata (shared by the view + the inspector) ──────────────────────

export const EDGE_KIND_META: Record<EdgeKind, { color: string; label: string; glyph: string }> = {
  handoff:  { color: "var(--accent)",        label: "handoff",  glyph: "⤚" },
  blocking: { color: "var(--info)",          label: "blocking", glyph: "⏸" },
  sequence: { color: "var(--fg-dim)",        label: "sequence", glyph: "→" },
  notify:   { color: "var(--fg-muted)",      label: "notify",   glyph: "◇" },
  mutex:    { color: "var(--danger)",        label: "mutex",    glyph: "⚠" },
  shared:   { color: "var(--violet)",        label: "shared",   glyph: "↔" },
  review:   { color: "oklch(0.70 0.14 350)", label: "review",   glyph: "✓" },
};

export const ARTIFACT_COLOR: Record<ArtifactKind, string> = {
  schema: "var(--success)", contract: "var(--info)", types: "var(--violet)",
  tokens: "var(--accent)", fixture: "var(--fg-muted)", other: "var(--fg-muted)",
};

export const DIRECTOR_COLOR = "oklch(0.70 0.14 350)";

export const ROLE_COLOR: Record<string, string> = {
  worker: "var(--accent)", tester: "var(--success)", reviewer: "var(--violet)",
  planner: "var(--info)", director: DIRECTOR_COLOR,
};

/** Dash + width per hardness (solid hard, dashed soft, dotted notify). */
export function hardStyle(h: Hardness): { dash: string; w: number } {
  return h === "blocking" ? { dash: "", w: 2.0 } : h === "soft" ? { dash: "6 4", w: 1.6 } : { dash: "2 4", w: 1.4 };
}

/** Human label for a hardness (the inspector + tooltips). */
export function hardLabel(h: Hardness): string {
  return h === "blocking" ? "hard wait" : h === "soft" ? "stub & reconcile" : "fire & forget";
}

/** Resting opacity per edge kind — handoff/blocking read bold, quieter kinds recede (swimlanes). */
export function restOpacity(kind: EdgeKind): number {
  return kind === "handoff" || kind === "blocking" ? 0.95 : kind === "sequence" ? 0.55 : kind === "notify" ? 0.4 : 0.5;
}

/** The one-line runtime note for an edge — how the relationship is enforced at fleet time. */
export function runtimeNote(e: ResolvedEdge): string {
  const map: Record<EdgeKind, string> = {
    // #3931: these used to advertise `bsc-blocked --on`, a command removed with #1039 and never
    // replaced — an agent that tried to run it got "command not found". Enforcement is now the LAUNCH
    // gate: `${e.to}` is not started until `${e.from}` lands, and a started worker never parks.
    handoff:  `${e.to} starts once ${e.from} lands contract:${e.artifact ?? "…"} (launch gate).`,
    blocking: `${e.to} is held at launch until ${e.from}'s work lands (launch gate).`,
    shared:   "co-owned interface — both streams notified on change.",
    review:   `${e.to}'s output reviewed before merge (role/flow gate).`,
    notify:   `event only — pings ${e.to}, never blocks.`,
    mutex:    "serialized — validated against owns[] glob overlap.",
    sequence: "pure ordering via dependsOn.",
  };
  return (e.viaEff === "director" ? "[via director] " : "[peer latch] ") + (map[e.kind] || "");
}

/** What the user is focused on — a stream lane, an edge, or an artifact. */
export type RelFocus = { type: "agent" | "edge" | "art"; id: string } | null;

export interface Spotlight {
  active: boolean;
  focusId?: string;
  focusType?: "agent" | "edge" | "art";
  /** Stream ids drawn bright; everything else dims. */
  brightStreams: Set<string>;
  /** Edge ids drawn lit. */
  litEdges: Set<string>;
  /** Artifact ids drawn lit. */
  litArtifacts: Set<string>;
}

/**
 * Resolve the spotlight for a focus (hover or pinned): which streams/edges/artifacts to
 * brighten and which to dim. An agent focus lights itself + its neighbors and every edge it
 * touches; an edge lights its endpoints; an artifact lights its producer + consumers and its
 * handoff edges. Pure — drives the swimlane opacities and is unit-testable.
 */
export function computeSpotlight(g: RelationshipGraph, focus: RelFocus): Spotlight {
  if (!focus) return { active: false, brightStreams: new Set(), litEdges: new Set(), litArtifacts: new Set() };
  const brightStreams = new Set<string>();
  const litEdges = new Set<string>();
  const litArtifacts = new Set<string>();
  if (focus.type === "agent") {
    const sp = neighborSpotlight(g.edges, focus.id);
    sp.litNodes.forEach((n) => brightStreams.add(n));
    sp.litEdges.forEach((id) => litEdges.add(id));
    for (const a of g.artifacts) if (a.producer === focus.id || a.consumers.includes(focus.id)) litArtifacts.add(a.id);
  } else if (focus.type === "edge") {
    const e0 = g.edges.find((e) => e.id === focus.id);
    if (e0) { brightStreams.add(e0.from); brightStreams.add(e0.to); litEdges.add(e0.id); if (e0.kind === "handoff" && e0.artifact) litArtifacts.add(e0.artifact); }
  } else {
    const a0 = g.artifacts.find((a) => a.id === focus.id);
    if (a0) {
      brightStreams.add(a0.producer); a0.consumers.forEach((c) => brightStreams.add(c)); litArtifacts.add(a0.id);
      for (const e of g.edges) if (e.kind === "handoff" && e.artifact === focus.id) litEdges.add(e.id);
    }
  }
  return { active: true, focusId: focus.id, focusType: focus.type, brightStreams, litEdges, litArtifacts };
}
