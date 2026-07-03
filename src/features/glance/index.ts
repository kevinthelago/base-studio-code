// Glance feature (#2206, epic #2205) — the workspace project-network map (projects as nodes,
// dependencies as edges, cross-project cycle hazards). Public API barrel.
export { GlanceWorkspace } from "./GlanceWorkspace";
export {
  buildGraph, focusSets, edgeGeom,
  ROLE_COLOR, STATUS_META, EDGE_META,
  type GraphModel, type GNode, type GEdge, type GRawNode, type GRawEdge, type GRole, type GStatus, type GEdgeKind,
} from "./lib/glanceGraph";
export { buildGlanceData, SAMPLE_GRAPH, type GlanceData, type ProjectLite } from "./lib/glanceData";
