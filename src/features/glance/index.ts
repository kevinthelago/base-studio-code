// Glance feature (#2206, epic #2205) — the workspace project-network map (projects as nodes,
// dependencies as edges, cross-project cycle hazards). Public API barrel.
export { GlanceWorkspace } from "./GlanceWorkspace";
export {
  buildGraph, focusSets, edgeGeom, rollUpHealth,
  ROLE_COLOR, CATEGORY_META, HEALTH_META, ACTIVITY_META, HEALTH_RANK, EDGE_META,
  type GraphModel, type GNode, type GEdge, type GRawNode, type GRawEdge, type GRole, type GCategory, type GHealth, type GActivity, type GEdgeKind,
} from "./lib/glanceGraph";
export { buildGlanceData, SAMPLE_GRAPH, type GlanceData, type ProjectLite } from "./lib/glanceData";
// #2498: the mobile store projector mirrors the SAME project/fault/fleet sources the Glance
// workspace reads, so the data hooks are public API alongside the graph model.
export { useGlanceProjects, applyFaultHealth, applyLiveness, applyRunningActivity, deriveBuildingKeys, mergeGlanceProjects } from "./lib/useGlanceProjects";
export { useGlanceFaults, type GlanceFault } from "./lib/useGlanceFaults";
export { applyStallHealth, projectKeyOfSession, STALL_WARN_MS, type WaitLite } from "./lib/agentStall";
export { useProjectFleet } from "./lib/useProjectFleet";
export { type ProjectLink } from "./lib/projectLinks";
