// Role → default permission profile — the unified model. Every session's ROLE decides which
// profile it launches under, so a director / worker / triage gets the right profile WITHOUT a
// per-stream generated profile or a manual assignment. The planner only LAYERS extra commands on
// top (it adds abilities, never replaces the role's profile). Profile ids match the packaged role
// JSON (`src-tauri/data/roles/`); kept as bare strings so this stays free of the agents feature
// (shared/ may not import features/).

import type { SessionRole } from "./sessionRoles";

/** The Sandboxed profile — the default for an ungated / manual pane (no role). */
export const DEFAULT_PROFILE_ID = "pf_sandbox";

/** Each session role's default profile id. Worker → Autonomous (trusted); director + the
 *  read-only coordination / observer roles → Read-only review; planner → its application role.
 *  Documentor (#1555) → Autonomous too: like the worker it must actually WRITE (its DOC_GLOBS prose
 *  docs), so it needs a write-permitting profile — the read-only profile's whole-tool write deny would
 *  mask the role gate's DOC_GLOBS carve-out (deny > allow). The role gate + the bsc-scope hook confine
 *  those writes to DOC_GLOBS, exactly as the worker's writes are confined to its owned lane. */
const ROLE_PROFILE: Record<SessionRole, string> = {
  worker: "pf_auto",
  director: "pf_review",
  triage: "pf_review",
  tester: "pf_review",
  reviewer: "pf_review",
  issuer: "pf_review",
  juror: "pf_review",
  documentor: "pf_auto",
  // Marketer (#2431): like the documentor it must actually WRITE (its marketing-content carve-out), so
  // it launches under the write-permitting Autonomous profile; the role gate + bsc-scope hook confine
  // its writes to the marketing globs.
  marketer: "pf_auto",
  planner: "sys_planner",
  // Designer (#2471): the Design Studio's UI-kit session. Read-only review is the closest packaged
  // floor; its real launch path (`useDesignerTerminal`) renders the role gate + `restrictedAllow`
  // directly, so this mapping only backs the generic role→profile surfaces.
  designer: "pf_review",
  // Architect (#2755): the Teams Studio's team-authoring session. Same as the designer — read-only
  // review is the closest packaged floor; its real launch path (`useArchitectTerminal`) renders the
  // role gate + `restrictedAllow` directly, so this mapping only backs the generic role→profile surfaces.
  architect: "pf_review",
};

/** The default profile id for a role (or the Sandboxed default when there's no role). */
export function roleProfileId(role: SessionRole | undefined | null): string {
  return role ? ROLE_PROFILE[role] : DEFAULT_PROFILE_ID;
}
