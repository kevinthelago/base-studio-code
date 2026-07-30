// The app-owned STUDIO sessions (#3357) — the one place that describes the designer / librarian /
// architect singleton sessions: their stable pane id, role, workspace-setup command, persona, tunnel
// roster entry, and the page they dock on. Pure + React-free so the registry is unit-testable and can be
// read from the store slice, the mount, the page docks, and the Glance wiring without a cycle.
//
// WHY A REGISTRY: before #3357 each studio owned a bespoke `use*Terminal` hook that mounted its OWN xterm
// via `useScreenSession`. That terminal could not be re-parented, so the Glance graph could not morph a
// studio node into its live session (only the debugger, already on TerminalHost, could). All three now
// launch through the SHARED TerminalHost like every fleet terminal — which means their launch inputs must
// live as DATA the generic launch path (`TerminalView` + `buildSessionSettings`) reads, not as a bespoke
// `pty_create` call. This file is that data.
import type { SessionRole } from "@/shared/lib/session/sessionRoles";
import {
  DESIGN_STUDIO_SESSION_ID,
  ALGORITHMS_STUDIO_SESSION_ID,
  TEAMS_STUDIO_SESSION_ID,
  SOUND_STUDIO_SESSION_ID,
  INTEGRATION_STUDIO_SESSION_ID,
} from "@/shared/lib/session/systemSessions";

/** The five app-owned studio sessions. (The DEBUG session is app-owned too but is full-capability and
 *  Settings-toggled, so it keeps its own `DebugSessionMount` — see `@/features/debug`.) */
export type StudioId = "designer" | "librarian" | "architect" | "soundDesigner" | "integrator";

/** Every studio id, in rail order. */
export const STUDIO_IDS: readonly StudioId[] = ["designer", "librarian", "architect", "soundDesigner", "integrator"];

export interface StudioSessionDef {
  id: StudioId;
  /** The stable, app-owned pane id (`systemSessions.ts`) — so re-opening re-uses the SAME session. */
  paneId: string;
  /** The role gate (#219) the session launches under. Set as `paneRoles[paneId]` and NOTHING else:
   *  `restrictedRoleCommands(role)` then makes `buildSessionSettings` emit `restrictedAllow`, so the
   *  session's whole auto-run surface is its store CLI. A pane PROFILE must never be assigned — that
   *  would ADD auto-approved commands on top of the restricted surface. */
  role: SessionRole;
  /** Tauri command that creates the studio's global workspace dir + writes its spec CLAUDE.md. */
  setupCommand: string;
  /** Key on `setupCommand`'s return object holding the workspace dir (the session's cwd). */
  dirKey: string;
  /** The built-in persona whose `startPrompt` is baked into the launch as `claude --initial-message`. */
  personaId: string;
  /** Display name in the mobile session roster (#2497). */
  rosterName: string;
  /** `usePageTabs` page key + section id of the page this studio docks on — the tear-off signal
   *  (`detachedSections[pageKey]` containing `sectionId` ⇒ another WINDOW owns this studio's terminal). */
  pageKey: string;
  sectionId: string;
  /** The studio's CURATED default skill ids — resolved from the library into `paneSkills` at launch
   *  (#3766). Unlike the global-enabled firehose a normal session gets, a restricted studio session is
   *  pinned to exactly this set (absent/empty ⇒ none, preserving the confinement boundary). This is how
   *  a11y + compliance guidance rides with the designer by construction. */
  defaultSkillIds?: string[];
}

export const STUDIO_SESSIONS: Record<StudioId, StudioSessionDef> = {
  designer: {
    id: "designer",
    paneId: DESIGN_STUDIO_SESSION_ID,
    role: "designer",
    setupCommand: "setup_designer_workspace",
    dirKey: "design_dir",
    personaId: "persona-designer",
    rosterName: "Design Studio",
    pageKey: "projects",
    sectionId: "designs",
    // Build components accessible + compliant BY CONSTRUCTION (#3766) — the author-time skills, not
    // the post-hoc *-audit/*-review ones the reviewer runs.
    defaultSkillIds: ["author-accessible-components", "author-compliant-components"],
  },
  librarian: {
    id: "librarian",
    paneId: ALGORITHMS_STUDIO_SESSION_ID,
    role: "librarian",
    setupCommand: "setup_librarian_workspace",
    dirKey: "algorithms_dir",
    personaId: "persona-librarian",
    rosterName: "Algorithms Studio",
    pageKey: "projects",
    sectionId: "algorithms",
  },
  soundDesigner: {
    id: "soundDesigner",
    paneId: SOUND_STUDIO_SESSION_ID,
    role: "sound-designer",
    setupCommand: "setup_sound_designer_workspace",
    dirKey: "sound_dir",
    personaId: "persona-sound-designer",
    rosterName: "Sound Studio",
    pageKey: "projects",
    sectionId: "sounds",
  },
  integrator: {
    id: "integrator",
    paneId: INTEGRATION_STUDIO_SESSION_ID,
    role: "integrator",
    setupCommand: "setup_integrator_workspace",
    dirKey: "integrations_dir",
    personaId: "persona-integrator",
    rosterName: "Integration Studio",
    pageKey: "projects",
    sectionId: "integrations",
    // #4023: the studio ships with its playbook — the same secret-free probe→try→register procedure
    // its spec describes, so the guidance rides with the session by construction rather than being
    // re-derived per conversation.
    defaultSkillIds: ["build-integration"],
  },
  architect: {
    id: "architect",
    paneId: TEAMS_STUDIO_SESSION_ID,
    role: "architect",
    setupCommand: "setup_architect_workspace",
    dirKey: "teams_dir",
    personaId: "persona-architect",
    rosterName: "Teams Studio",
    pageKey: "projects",
    sectionId: "teams",
  },
};

/** Where a failed `--continue` writes its reason. Under `$BSC_LOG_DIR` (set per-pane by `pty_create`,
 *  alongside the audit/coord/perf streams), so it sits with the rest of a session's diagnostics. */
export const STUDIO_RESUME_LOG = "studio-resume.log";

/**
 * Resume the prior studio conversation across app restarts, else launch a fresh session.
 *
 * The `|| claude` fallback is deliberate — a genuinely first launch has nothing to resume. What was
 * NOT deliberate is that the old form (`claude --continue 2>/dev/null || claude`) **discarded the
 * reason** and degraded silently: a session that failed to resume looked identical to one that had
 * never run, with no log line and nothing in the pane. That made #3374 — studios starting a fresh
 * conversation across restarts — impossible to diagnose, because the one signal that would explain it
 * was being thrown away on every launch.
 *
 * So stderr now APPENDS to `$BSC_LOG_DIR/studio-resume.log` instead of `/dev/null`, and the fallback
 * announces itself in the pane. Behaviour is otherwise unchanged: resume when there is something to
 * resume, start fresh when there isn't.
 *
 * `${BSC_LOG_DIR:-/tmp}` guards the (unexpected) case of an unset log dir — a missing diagnostic must
 * never stop the session launching.
 */
export const STUDIO_INIT_CMD =
  `claude --continue 2>>"\${BSC_LOG_DIR:-/tmp}/${STUDIO_RESUME_LOG}"` +
  ` || { echo "[studio] no prior session resumed — starting fresh (why: \${BSC_LOG_DIR:-/tmp}/${STUDIO_RESUME_LOG})"; claude; }`;

/** Narrow an arbitrary string (a Glance node id, a persisted value) to a StudioId. */
export function isStudioId(value: string | null | undefined): value is StudioId {
  return !!value && (STUDIO_IDS as readonly string[]).includes(value);
}

/** The studio owning a pane id, or null for any other pane (fleet, planner, debug, manual). */
export function studioForPaneId(paneId: string): StudioId | null {
  return STUDIO_IDS.find((id) => STUDIO_SESSIONS[id].paneId === paneId) ?? null;
}

/**
 * The role gate a studio pane launches under, DERIVED from its pane id (#3423) — so confinement travels
 * with the session's identity instead of depending on setup having run first.
 *
 * `paneRoles[paneId]` is what makes a pane a designer, and it used to be written ONLY by
 * `seedStudioLaunchState` inside `StudioSessionMount`'s effect. That component renders only for studios in
 * `wantedStudios`, which is deliberately transient (absent from `partialize`), so after any app restart the
 * set is empty and nothing mounts. Opening a studio then created a terminal on a studio pane id with NO role
 * in the store — and `buildSessionSettings` applies no role gate, no `restrictedAllow` and no denies when it
 * finds none. The result was a fully UNCONFINED general shell on the app's most restricted surface.
 *
 * A studio's pane id is stable and app-owned, so it is sufficient on its own to establish the role. Null for
 * any other pane, where the store remains the only authority.
 */
export function studioRoleForPaneId(paneId: string): SessionRole | null {
  const id = studioForPaneId(paneId);
  return id ? STUDIO_SESSIONS[id].role : null;
}

/**
 * Whether this studio's page is TORN OFF into its own window (#430/#463). The detached window runs its
 * OWN React root + store + TerminalHost, so it becomes the sole owner of the studio's single terminal —
 * the main window must release it (not mount a second xterm onto the same PTY, which would fight over
 * `pty_resize`). `detachedSections` is transient per-window state, so the detached window itself always
 * reads `false` here and mounts the session normally. Pure.
 */
export function studioDetached(id: StudioId, detachedSections: Record<string, string[]>): boolean {
  const def = STUDIO_SESSIONS[id];
  return (detachedSections[def.pageKey] ?? []).includes(def.sectionId);
}
