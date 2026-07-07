// Glance feature (#2206, epic #2205) — the workspace project-network map (projects as nodes,
// dependencies as edges, cross-project cycle hazards). Public API barrel.
export { GlanceWorkspace } from "./GlanceWorkspace";
export {
  buildGraph, focusSets, edgeGeom, rollUpHealth,
  ROLE_COLOR, HEALTH_META, ACTIVITY_META, HEALTH_RANK, EDGE_META,
  type GraphModel, type GNode, type GEdge, type GRawNode, type GRawEdge, type GRole, type GHealth, type GActivity, type GEdgeKind,
} from "./lib/glanceGraph";
export { buildGlanceData, SAMPLE_GRAPH, type GlanceData, type ProjectLite } from "./lib/glanceData";
// #2498: the mobile store projector mirrors the SAME project/fault/fleet sources the Glance
// workspace reads, so the data hooks are public API alongside the graph model.
export { useGlanceProjects, applyFaultHealth, applyLiveness, mergeGlanceProjects } from "./lib/useGlanceProjects";
export { useGlanceFaults, type GlanceFault } from "./lib/useGlanceFaults";
export { useProjectFleet } from "./lib/useProjectFleet";
export { type ProjectLink } from "./lib/projectLinks";
