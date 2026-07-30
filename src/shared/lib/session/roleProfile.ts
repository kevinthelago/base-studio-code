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
  // Designer (#2471) / Architect (#2755) / Librarian (#2787): the three app-owned studio sessions.
  // Read-only review is the closest packaged floor, but this mapping ONLY backs the generic role→profile
  // UI surfaces — it is NOT applied at launch. Their real launch (`StudioSessionMount` on TerminalHost,
  // #3357) sets `paneRoles` and deliberately NO `paneProfiles` entry, because `buildSessionSettings` ADDS
  // a profile's allowedCommands to the role's `restrictedAllow` surface — i.e. assigning a profile here
  // would WIDEN a session confined to one store CLI. Don't wire this into a launch path.
  designer: "pf_review",
  architect: "pf_review",
  librarian: "pf_review",
  "sound-designer": "pf_review",
  // Integrator (#4023): the same studio treatment — read-only review is the closest packaged floor, and
  // this mapping likewise only backs the generic role→profile UI surfaces. Its `net: "read"` widening
  // comes from the ROLE capability, not from a profile, so nothing here needs to grant it.
  integrator: "pf_review",
  // Debugger (#3322): the app's full-cap maintenance session WRITES code, so like the worker it launches
  // under the write-permitting Autonomous profile; its real launch (`DebugSessionMount` on TerminalHost,
  // #3326) renders bypass directly via the `isFullCapabilitySession` carve-out, so this only backs the
  // generic role→profile surfaces.
  debugger: "pf_auto",
  // Curator (#3092, epic #3087): the reusable-library post-landing actor. Read-only review is the
  // closest packaged floor; its real launch (P2b) renders the role gate + `restrictedAllow` (`bsc ui` +
  // `bsc graph`) directly. Its store writes go through `bsc ui`/`bsc graph` (Bash + the `ui` write-scope),
  // not the file-write tools, so the review profile's whole-tool write deny doesn't mask them.
  curator: "pf_review",
};

/** The default profile id for a role (or the Sandboxed default when there's no role). */
export function roleProfileId(role: SessionRole | undefined | null): string {
  return role ? ROLE_PROFILE[role] : DEFAULT_PROFILE_ID;
}
