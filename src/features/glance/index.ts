// Glance feature (#2206, epic #2205) — the workspace project-network map (projects as nodes,
// dependencies as edges, cross-project cycle hazards). Public API barrel.
export { GlanceWorkspace } from "./GlanceWorkspace";
export {
  buildGraph, focusSets, edgeGeom, rollUpHealth,
  ROLE_COLOR, HEALTH_META, ACTIVITY_META, HEALTH_RANK, EDGE_META,
  KIT_COLOR, KIT_NODE_PREFIX, kitNodeId, kitIdOfNode, usesKitEdgeId,
  // Cross-graph library dimension (#3119, epic #3114) — the generalized band-node API B/C wires real
  // `requires` deps into (algorithms/sounds), alongside the kept `uses-kit`/`kit` names.
  ALGO_COLOR, SOUND_COLOR, LIBRARY_META, LIBRARY_NODE_PREFIX, libraryNodeId, libIdOfNode, requiresEdgeId,
  isLibraryNode, libraryGraphOf, isLibraryEdge,
  type GraphModel, type GNode, type GEdge, type GRawNode, type GRawEdge, type GRole, type GHealth, type GActivity, type GEdgeKind, type GNodeKind, type GLibraryGraph,
} from "./lib/glanceGraph";
export { buildGlanceData, SAMPLE_GRAPH, type GlanceData, type ProjectLite, type KitLite } from "./lib/glanceData";
// #2498: the mobile store projector mirrors the SAME project/fault/fleet sources the Glance
// workspace reads, so the data hooks are public API alongside the graph model.
export { useGlanceProjects, applyFaultHealth, applyLiveness, applyRunningActivity, deriveBuildingKeys, mergeGlanceProjects } from "./lib/useGlanceProjects";
export { useGlanceFaults, type GlanceFault } from "./lib/useGlanceFaults";
export { applyStallHealth, projectKeyOfSession, STALL_WARN_MS, type WaitLite } from "./lib/agentStall";
export { useProjectFleet } from "./lib/useProjectFleet";
export { type ProjectLink } from "./lib/projectLinks";
// #3931: the fleet resume is the launch pump's actuator (mounted in the app shell), so it is public API.
export { resumeProjectFleet, nothingToResume, type ResumeResult, type BlockedStream } from "./lib/resumeProject";
// #4103: the non-hook issue-state resolver — the fleet gates in OTHER features (the publish-time
// prune) need it outside a render, and a feature is reached only through its barrel.
export { resolveClosedRefs, type RefBearingStream } from "./lib/fleetIssueState";
