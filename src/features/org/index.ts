// Org feature (#2193) — the persona-relationship graph: positions wired by relationship archetypes
// that expand into communication forms. Public API barrel.
export { OrgPanel } from "./OrgPanel";
export { createOrgSlice, type OrgSlice } from "./store";
export {
  BUILTIN_ORGS, RELATIONSHIP_ARCHETYPES, COMMUNICATION_FORMS,
  makeBuiltinOrgs, reconcileOrgs, blankOrg, orgSlug, orgIssues, deriveCommunication,
  archetypeById, formById,
  type Org, type Position, type Relationship, type RelationshipArchetype,
  type CommunicationForm, type CommEdge, type PositionKind,
} from "./lib/org";
