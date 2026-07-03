// Shared graph core (#2214, epic) — the pure (React-free) graph primitives that Glance, the Org
// designer, and the agent-relationship graph all build on, so layering/cycle/focus logic lives once
// instead of being re-copied per domain (#2204: "layout is a function of the data structure"). The
// render layer is already shared (GraphCanvas + useGraphViewport, #2208); this is the model layer.
//
// Each feature extends these bases with its own domain fields (role/status/kind/hardness/…) and
// palettes — the core only knows ids + direction.

/** The minimum a node needs to participate in the shared graph algorithms. */
export interface GraphNode {
  id: string;
}

/** A directed edge; `from`/`to` are node ids. Direction matters for layering + cycle detection. */
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
}
