// Neighbor spotlight (#2215, graph-core epic #2214) — the shared "focus dims the rest" primitive. Given
// a node in focus (hovered/selected), it returns the node itself + its direct neighbors (in either
// direction) and every edge touching it, so the view can brighten those and dim everything else. Both
// Glance (focusSets) and the agent-relationship graph (computeSpotlight) resolve their node/agent focus
// this way; each layers its own domain extras on top (Glance's edge/cycle branches; the relationship
// graph's artifact lighting).
import type { GraphEdge } from "./types";

export interface Spotlight {
  /** The focused node + its direct neighbors. */
  litNodes: Set<string>;
  /** Every edge incident to the focused node. */
  litEdges: Set<string>;
}

/** The node in focus + its neighbors (either direction) + the edges touching it. Pure. */
export function neighborSpotlight(edges: readonly GraphEdge[], focusId: string): Spotlight {
  const litNodes = new Set<string>([focusId]);
  const litEdges = new Set<string>();
  for (const e of edges) {
    if (e.from === focusId) { litNodes.add(e.to); litEdges.add(e.id); }
    if (e.to === focusId) { litNodes.add(e.from); litEdges.add(e.id); }
  }
  return { litNodes, litEdges };
}
