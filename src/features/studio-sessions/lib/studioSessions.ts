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
  designerSessionId,
  librarianSessionId,
  TEAMS_STUDIO_SESSION_ID,
  SOUND_STUDIO_SESSION_ID,
  INTEGRATION_STUDIO_SESSION_ID,
} from "@/shared/lib/session/systemSessions";

/** The app-owned studio sessions. (The DEBUG session is app-owned too but is full-capability and
 *  Settings-toggled, so it keeps its own `DebugSessionMount` — see `@/features/debug`.)
 *
 *  PER TECHNOLOGY (#system-sessions-are-per-technology) for the two studios whose store is partitioned:
 *  the LIBRARIAN by `impl.tech` on the algorithms graph, the DESIGNER by `kit.tech` on the component
 *  store. The sound-designer and integrator stay single — their stores carry no tech facet at any
 *  level, and splitting a studio with nothing to split just doubles the sessions.
 *
 *  These are LITERALS, not generated, because a `StudioId` is a compile-time key: it types
 *  `wantedStudios`, `studioViewers`, every store map and the closed set `bsc session` resolves against.
 *  A runtime-materialised session would have none of those. */
export type StudioId =
  | "designerReact" | "designerReactNative"
  | "librarianRust" | "librarianTypescript" | "librarianPython"
  | "architect" | "soundDesigner" | "integrator";

/** Every studio id, in rail order. */
export const STUDIO_IDS: readonly StudioId[] = [
  "designerReact", "designerReactNative",
  "librarianRust", "librarianTypescript", "librarianPython",
  "architect", "soundDesigner", "integrator",
];

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
  /** The TECHNOLOGY this session curates (#system-sessions-are-per-technology), for the studios whose
   *  store is partitioned. Absent for a single-technology studio (architect / sound-designer /
   *  integrator). Drives {@link studioScopeDirective}, which is what actually makes a per-tech session
   *  behave differently from its siblings — without it, three librarians would launch identically and
   *  each would curate the whole graph, which is the state this split exists to end. */
  tech?: string;
  /** The studio's CURATED default skill ids — resolved from the library into `paneSkills` at launch
   *  (#3766). Unlike the global-enabled firehose a normal session gets, a restricted studio session is
   *  pinned to exactly this set (absent/empty ⇒ none, preserving the confinement boundary). This is how
   *  a11y + compliance guidance rides with the designer by construction. */
  defaultSkillIds?: string[];
}

export const STUDIO_SESSIONS: Record<StudioId, StudioSessionDef> = {
  designerReact: {
    id: "designerReact",
    paneId: designerSessionId("react"),
    role: "designer",
    tech: "react",
    setupCommand: "setup_designer_workspace",
    dirKey: "design_dir",
    personaId: "persona-designer",
    rosterName: "Design Studio · React",
    pageKey: "projects",
    sectionId: "designs",
    // Build components accessible + compliant BY CONSTRUCTION (#3766) — the author-time skills, not
    // the post-hoc *-audit/*-review ones the reviewer runs.
    defaultSkillIds: ["author-accessible-components", "author-compliant-components"],
  },
  designerReactNative: {
    id: "designerReactNative",
    paneId: designerSessionId("react-native"),
    role: "designer",
    tech: "react-native",
    setupCommand: "setup_designer_workspace",
    dirKey: "design_dir",
    personaId: "persona-designer",
    rosterName: "Design Studio · React Native",
    pageKey: "projects",
    sectionId: "designs",
    defaultSkillIds: ["author-accessible-components", "author-compliant-components"],
  },
  librarianRust: {
    id: "librarianRust",
    paneId: librarianSessionId("rust"),
    role: "librarian",
    tech: "rust",
    setupCommand: "setup_librarian_workspace",
    dirKey: "algorithms_dir",
    personaId: "persona-librarian",
    rosterName: "Algorithms Studio · Rust",
    pageKey: "projects",
    sectionId: "algorithms",
  },
  librarianTypescript: {
    id: "librarianTypescript",
    paneId: librarianSessionId("typescript"),
    role: "librarian",
    tech: "typescript",
    setupCommand: "setup_librarian_workspace",
    dirKey: "algorithms_dir",
    personaId: "persona-librarian",
    rosterName: "Algorithms Studio · TypeScript",
    pageKey: "projects",
    sectionId: "algorithms",
  },
  librarianPython: {
    id: "librarianPython",
    paneId: librarianSessionId("python"),
    role: "librarian",
    tech: "python",
    setupCommand: "setup_librarian_workspace",
    dirKey: "algorithms_dir",
    personaId: "persona-librarian",
    rosterName: "Algorithms Studio · Python",
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

/**
 * The scoping line a per-technology studio launches with, appended to its persona prompt.
 *
 * THIS IS WHAT MAKES THE SPLIT REAL. Five sessions sharing one persona and one workspace would launch
 * identically and each would curate the whole store — the split would cost five processes and change
 * nothing. The directive names the session's technology AND the filtered read that scopes it, so the
 * session knows what it owns from its first turn.
 *
 * The two studios are scoped by DIFFERENT queries, because their stores carry `tech` at different
 * levels: an algorithms implementation carries it directly (`bsc graph impl list --tech <t>`), while a
 * component carries it via its KIT (`bsc ui kit list` → the kits whose tech matches → `--kit <id>`).
 * A single generic "filter by tech" would be wrong for one of them, so the two are written out.
 *
 * Empty for a studio with no `tech` — the architect, sound-designer and integrator curate everything
 * their store holds, and appending a scoping line that names no scope would be noise.
 */
export function studioScopeDirective(def: StudioSessionDef): string {
  if (!def.tech) return "";
  const read =
    def.role === "librarian"
      ? `Your partition is \`bsc graph impl list --tech ${def.tech}\`. Every implementation you curate, ` +
        `harvest or optimize is a ${def.tech} one.`
      : `Your partition is the kits whose \`tech\` is \`${def.tech}\` — list them with ` +
        `\`bsc ui kit list\`, then read each with \`bsc ui list --kit <kitId>\`. Every component you ` +
        `author or edit belongs to one of those kits.`;
  return (
    `## Your technology: ${def.tech}

` +
    `You are the ${def.tech} ${def.role}. ${read}

` +
    `Sibling sessions curate the other technologies — do NOT edit records outside your partition. ` +
    `A ${def.tech} artifact and its equivalent in another technology are different artifacts, not two ` +
    `copies of one, which is exactly why there is a session per technology rather than one over all ` +
    `of them.`
  );
}

/**
 * The studio session that curates `tech`, for a role whose store is partitioned
 * (#system-sessions-are-per-technology).
 *
 * This is how a PAGE follows its own selection: the Algorithms page's language rail and the Design
 * page's kit both already name a technology, so the dock resolves that to a session id rather than
 * holding a second selection of its own. Two selections for one concept is how they drift apart.
 *
 * Null for a technology with no session — a graph that grows a fourth language, or a kit whose `tech`
 * is not one this app ships a designer for. The dock then shows nothing rather than defaulting to
 * SOME session, because silently docking the rust librarian on a page showing go algorithms is worse
 * than an empty dock: it looks like it is working.
 */
export function studioForTech(role: "librarian" | "designer", tech: string): StudioId | null {
  return STUDIO_IDS.find((id) => STUDIO_SESSIONS[id].role === role && STUDIO_SESSIONS[id].tech === tech) ?? null;
}

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
