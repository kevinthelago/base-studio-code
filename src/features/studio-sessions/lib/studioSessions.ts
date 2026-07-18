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
} from "@/shared/lib/session/systemSessions";

/** The three app-owned studio sessions. (The DEBUG session is app-owned too but is full-capability and
 *  Settings-toggled, so it keeps its own `DebugSessionMount` — see `@/features/debug`.) */
export type StudioId = "designer" | "librarian" | "architect";

/** Every studio id, in rail order. */
export const STUDIO_IDS: readonly StudioId[] = ["designer", "librarian", "architect"];

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

/** Resume the prior studio conversation across app restarts, else launch a fresh session. Verbatim from
 *  the pre-#3357 bespoke `pty_create` calls (all three used the identical init). */
export const STUDIO_INIT_CMD = "claude --continue 2>/dev/null || claude";

/** Narrow an arbitrary string (a Glance node id, a persisted value) to a StudioId. */
export function isStudioId(value: string | null | undefined): value is StudioId {
  return !!value && (STUDIO_IDS as readonly string[]).includes(value);
}

/** The studio owning a pane id, or null for any other pane (fleet, planner, debug, manual). */
export function studioForPaneId(paneId: string): StudioId | null {
  return STUDIO_IDS.find((id) => STUDIO_SESSIONS[id].paneId === paneId) ?? null;
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
