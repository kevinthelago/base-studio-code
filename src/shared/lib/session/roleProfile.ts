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
 *  read-only coordination / observer roles → Read-only review; planner → its application role. */
const ROLE_PROFILE: Record<SessionRole, string> = {
  worker: "pf_auto",
  director: "pf_review",
  triage: "pf_review",
  tester: "pf_review",
  reviewer: "pf_review",
  conductor: "pf_review",
  issuer: "pf_review",
  juror: "pf_review",
  planner: "sys_planner",
};

/** The default profile id for a role (or the Sandboxed default when there's no role). */
export function roleProfileId(role: SessionRole | undefined | null): string {
  return role ? ROLE_PROFILE[role] : DEFAULT_PROFILE_ID;
}
