// Selection neighborhood (#2523, promoted to shared #2719) — a pure graph query used by every graph
// canvas that highlights a selection: given the edge set and a selected node id, return the edges
// incident to it and the nodes on the far end of those edges. React-free and layout-agnostic (it
// only needs `from`/`to`/`id` on each edge), so it lives alongside the other shared graph model
// helpers rather than in any one feature.
import type { GraphEdge } from "./types";

export interface SelectionNeighborhood {
  /** Edge ids incident to the selected node (`from === selId || to === selId`). */
  incidentEdges: Set<string>;
  /** Node ids directly connected to the selected node — the selection itself is never included. */
  relatedNodes: Set<string>;
}

/** The selection neighborhood of a node: the edges touching it and the nodes on the far end. A
 *  GraphView highlights the incident edges in accent and softly rings the related nodes. Empty when
 *  `selId` is falsy (nothing selected). A self-loop never marks the selection as its own relation. */
export function selectionNeighborhood(edges: readonly GraphEdge[], selId: string): SelectionNeighborhood {
  const incidentEdges = new Set<string>();
  const relatedNodes = new Set<string>();
  if (!selId) return { incidentEdges, relatedNodes };
  for (const e of edges) {
    if (e.from === selId) { incidentEdges.add(e.id); relatedNodes.add(e.to); }
    else if (e.to === selId) { incidentEdges.add(e.id); relatedNodes.add(e.from); }
  }
  relatedNodes.delete(selId); // a self-loop must not mark the selection as its own relation
  return { incidentEdges, relatedNodes };
}
