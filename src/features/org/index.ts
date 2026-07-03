// Org feature (#2193) — the persona-relationship graph: positions wired by relationship archetypes
// that expand into communication forms. Public API barrel.
export { OrgPanel } from "./OrgPanel";
export { OrgCanvas, type Selection } from "./OrgCanvas";
export { OrgInspector } from "./OrgInspector";
export { TierChips, FormChip, FormLane, SectionLabel } from "./components";
export { createOrgSlice, type OrgSlice } from "./store";
export {
  positionDisplay, positionComms, tierChips, formColor, formArrow, hueColor, ROLE_META,
  type PositionDisplay, type CommSummary,
} from "./lib/orgView";
export { nodeBox, edgeGeometry, anchor, NODE_SIZE, CANVAS_W, CANVAS_H } from "./lib/orgLayout";
export {
  BUILTIN_ORGS, RELATIONSHIP_ARCHETYPES, COMMUNICATION_FORMS,
  makeBuiltinOrgs, reconcileOrgs, blankOrg, orgSlug, orgIssues, deriveCommunication,
  archetypeById, formById,
  type Org, type Position, type Relationship, type RelationshipArchetype,
  type CommunicationForm, type CommEdge, type PositionKind,
} from "./lib/org";
