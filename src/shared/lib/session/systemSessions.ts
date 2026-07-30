// App-owned "studio" sessions (#3137) — the single source of truth for the fixed pane ids of the
// dedicated, app-launched singleton terminal sessions: the DESIGNER (Design Studio), the LIBRARIAN
// (Algorithms), the ARCHITECT (Teams), and the SOUND-DESIGNER (Sounds). Each is a singleton session the app owns and re-creates on
// demand — NOT a fleet worker and NOT something the user restores. Since #3357 all three (like the DEBUG
// session, #3326) run on the shared TerminalHost via `@/features/studio-sessions`, not on their own page-owned
// xterm; their ids stay fixed here so the lifecycle, the Glance morph, and recovery all agree.
//
// Their ids follow the `<key>:<tail>` grammar, so `parsePaneIdentity` would otherwise classify them as
// fleet WORKERS and the crash-recovery banner would offer to restore them (#3137). This module names
// them in ONE feature-agnostic place so both the feature hooks (which import their `*_PANE_ID` from here)
// and the recovery reconcile (`reconcileSessions`, which excludes them) agree — a new studio added here
// is excluded everywhere at once. The PLANNER is the sibling app-owned session, but it has a DYNAMIC
// per-project id (`planning_<key>`) and its own `isPlanningPaneId` guard, so it isn't listed here.

/** The Design Studio's app-owned designer session. */
export const DESIGN_STUDIO_SESSION_ID = "design-studio:designer";
/** The Algorithms studio's app-owned librarian session. */
export const ALGORITHMS_STUDIO_SESSION_ID = "algorithms-studio:librarian";
/** The Teams studio's app-owned architect session. */
export const TEAMS_STUDIO_SESSION_ID = "teams-studio:architect";
/** The Sound studio's app-owned sound-designer session (#3369, epic #3071 phase 4). */
export const SOUND_STUDIO_SESSION_ID = "sound-studio:sound-designer";
/** The Integration studio's app-owned integrator session (#4023) — builds and maintains the app's
 *  integrations with existing applications/APIs through `bsc data connector`. */
export const INTEGRATION_STUDIO_SESSION_ID = "integration-studio:integrator";
/** The Debug studio's app-owned debugger session (#3298) — a full-capability session in the
 *  base-studio-code SOURCE tree that works the `bsc request` improvement queue (fixing `bsc ui`),
 *  hosted in its own OS window and toggled from Settings. */
export const DEBUG_STUDIO_SESSION_ID = "debug-studio:debugger";

/** The pane-id prefix shared by EVERY session in the debug studio: the standing debugger
 *  (`debug-studio:debugger`) and each auto-spawned per-request session (`debug-studio:req-<id>`,
 *  {@link poolPaneId}). Every one of them is the app's full-capability maintenance session in the
 *  source tree, so the prefix — not the singleton id — is what `isFullCapabilitySession` keys on. */
export const DEBUG_STUDIO_PANE_PREFIX = "debug-studio:";

/** Every fixed, app-owned studio session pane id. */
export const STUDIO_SESSION_PANE_IDS: readonly string[] = [
  DESIGN_STUDIO_SESSION_ID,
  ALGORITHMS_STUDIO_SESSION_ID,
  TEAMS_STUDIO_SESSION_ID,
  SOUND_STUDIO_SESSION_ID,
  INTEGRATION_STUDIO_SESSION_ID,
  DEBUG_STUDIO_SESSION_ID,
];

/** Whether `id` is a fixed, app-owned studio session (designer / librarian / architect / sound-designer /
 *  integrator) — excluded from
 *  crash recovery the way the planner (`isPlanningPaneId`) is: re-created when its workspace opens, never
 *  restored from the recovery banner. */
export function isStudioSessionPaneId(id: string): boolean {
  return STUDIO_SESSION_PANE_IDS.includes(id);
}

/** Whether `id` is a FULL-CAPABILITY app-owned session that must ALWAYS launch bypass + role-less,
 *  regardless of the global permission posture (`bypassPermissions`) — ANY session in the debug studio
 *  (#3326/#3520). Unlike a fleet/console pane, whose posture comes from the store (role/profile/flow + the
 *  global bypass toggle), a debug-studio session is BY DEFINITION the unrestricted maintenance session in
 *  the base-studio-code source tree; `buildSessionSettings` forces `bypass:true` for it. Role-less is
 *  automatic — no `paneRoles` entry is set for these panes and `studioRoleForPaneId` matches only the four
 *  fixed studios, so no role gate applies.
 *
 *  Matches the whole `debug-studio:` family, not just the singleton (#3520): the standing debugger AND each
 *  auto-spawned per-request session (`debug-studio:req-<id>`, #3498). A req session is the same kind of
 *  actor as the standing one — app-owned, in the source tree, working the request queue — and the control
 *  gate is the human reviewing its PR, not a per-tool permission prompt. Keying on the singleton id left
 *  the spawned sessions falling through to the global toggle, so they stopped to ask for every edit. */
export function isFullCapabilitySession(id: string): boolean {
  return id.startsWith(DEBUG_STUDIO_PANE_PREFIX);
}
