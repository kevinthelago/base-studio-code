// Team feature (#2193) — the persona-relationship graph: positions wired by relationship archetypes
// that expand into communication forms. Public API barrel.
export { TeamsPanel } from "./TeamsPanel";
export { TeamsCanvas, OrgLegend, type Selection } from "./TeamsCanvas";
export { TeamsInspector } from "./TeamsInspector";
export { FormChip, FormLane } from "./components";
export { createOrgSlice, type OrgSlice } from "./store";
export {
  positionDisplay, positionComms, tierChips, formColor, formArrow, hueColor, ROLE_META,
  type PositionDisplay, type CommSummary,
} from "./lib/orgView";
export { nodeBox, edgeGeometry, autoLayout, NODE_SIZE, CANVAS_W, CANVAS_H } from "./lib/orgLayout";
// `anchor` lives in the shared graph core since #2418 (org's copy was byte-identical); `clampZoom`
// was dead vs useGraphViewport's clamping and was dropped.
export { anchor } from "@/shared/lib/graph/edgePath";
export { detectPools, collapseOrg, poolSubgraph, type Pool, type CollapsedOrg } from "./lib/orgPools";
export {
  BUILTIN_ORGS, RELATIONSHIP_ARCHETYPES, COMMUNICATION_FORMS,
  makeBuiltinOrgs, reconcileOrgs, blankOrg, orgSlug, orgIssues, deriveCommunication,
  augmentStudioNetworkForDebug, augmentStudioNetworkForRequests, STUDIO_NETWORK_ID,
  archetypeById, formById,
  type Team, type Position, type Relationship, type RelationshipArchetype,
  type CommunicationForm, type CommEdge, type PositionKind,
} from "./lib/team";
// The effective-team precedence resolver (#3152, epic #3151) — the planner's `teamFleet.ts` composes
// this with its own `bsc plan team get` binding + `blueprint.team` once #3152's plan.db/CLI half
// lands (blocked on this stream's write scope; see `bsc plan request 1`).
export { effectiveTeam, type TeamGraph } from "./lib/effectiveTeam";
