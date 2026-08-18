// The shadow catalogue registers this feature's graph-platform modules by importing
// `./graphPlatform` DIRECTLY and calling its register function (see `shadowPages.ts`). This barrel
// therefore has NO import-time side effect — it is re-exports only, which is what lets it be a
// record rather than a file that must run to be correct.

// Team feature (#2193) — the persona-relationship graph: positions wired by relationship archetypes
// that expand into communication forms. Public API barrel.
export { TeamsPanel } from "@/features/teams/TeamsPanel";
export { TeamsCanvas, OrgLegend, type Selection } from "@/features/teams/TeamsCanvas";
export { TeamsInspector } from "@/features/teams/TeamsInspector";
export { FormChip, FormLane } from "@/features/teams/components";
export { createOrgSlice, type OrgSlice } from "@/features/teams/store";
export {
  positionDisplay, positionComms, tierChips, formColor, formArrow, hueColor, ROLE_META,
  type PositionDisplay, type CommSummary,
} from "@/features/teams/lib/orgView";
export { nodeBox, edgeGeometry, autoLayout, NODE_SIZE, CANVAS_W, CANVAS_H } from "./lib/orgLayout";
// `anchor` lives in the shared graph core since #2418 (org's copy was byte-identical); `clampZoom`
// was dead vs useGraphViewport's clamping and was dropped.
export { anchor } from "@/shared/lib/graph/edgePath";
export { detectPools, collapseOrg, poolSubgraph, type Pool, type CollapsedOrg } from "@/features/teams/lib/orgPools";
export {
  BUILTIN_ORGS, RELATIONSHIP_ARCHETYPES, COMMUNICATION_FORMS,
  makeBuiltinOrgs, reconcileOrgs, blankOrg, orgSlug, orgIssues, deriveCommunication,
  augmentStudioNetworkForRequests, requestNodeLabel, STUDIO_NETWORK_ID,
  studioNetworkForArchitect, ARCHITECT_NODE,
  archetypeById, formById,
  type Team, type Position, type Relationship, type RelationshipArchetype,
  type CommunicationForm, type CommEdge, type PositionKind, type RequestNodeSpec, type OriginHostResolver,
} from "./lib/team";
