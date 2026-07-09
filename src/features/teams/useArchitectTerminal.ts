// useArchitectTerminal (#2755) — the Teams Studio's dedicated, heavily-restricted team-authoring
// session. A near-verbatim mirror of the Design Studio's `useDesignerTerminal` (#2471): the same
// xterm + PTY lifecycle (via the shared `useScreenSession`), `ensure_session_settings` before launch,
// and `pty_create` with the startup prompt BAKED into the launch arg (never typed after idle
// detection — the established rule). Every invoke/pty_create arg shape is identical to the designer's;
// only the command surface, role, workspace, and persona differ.
//
// What makes it the ARCHITECT session:
//   • cwd — the global `~/.base-studio-code/teams-studio/` workspace (`setup_architect_workspace`
//     creates it + writes the architect-spec CLAUDE.md from the packaged seed).
//   • role gate — `roleCapability("architect")` (#219): none on every axis (incl. `ui: none` — it is
//     NOT a UI-kit session). Its git/gh denies + write-tool denies + web-tool denies are rendered
//     into the session settings.
//   • restricted allow-list — `restrictedAllow: true` suppresses the baseline command tiers, so the
//     session's ENTIRE auto-runnable surface is `bsc teams` + `bsc persona`.
//   • startup prompt — the built-in team-architect persona's startPrompt (user-editable via Personas).
//   • resume — `continueSession` + a `claude --continue || claude` init, like the designer, so a
//     relaunch resumes the prior conversation.
//
// The generic console TerminalView is deliberately NOT reused (pane-system baggage); this hook tears
// the session down when the panel unmounts (leaving the entered team → back to the Teams overview).
import { type RefObject } from "react";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import {
  roleCapability,
  roleDeniedCommands,
  roleDeniedTools,
  roleWriteRules,
  sessionScopes,
} from "@/shared/lib/session/sessionRoles";
import { useScreenSession } from "@/shared/lib/session/useScreenSession";
import { BUILTIN_PERSONAS } from "@/features/personas";
// The shared xterm terminal theme. The designer deep-imports the planner's theme leaf (its feature is
// an exempt importer, #2197); `teams` is NOT exempt, so it sources the same theme from the console's
// canonical constants (a lint-clean feature→app import, as the tunnel feature already does) instead of
// duplicating the literal.
import { TERM_THEME } from "@/app/console/lib/terminalConstants";

/** The architect session's stable pane id — one global session, keyed like `<project>:<stream>`. */
export const ARCHITECT_PANE_ID = "teams-studio:architect";

/** The architect's whole command surface: `bsc teams` (the persona-relationship graph) + `bsc persona`
 *  (agent identities), emitted as the session's ONLY `Bash(<cmd> *)` allows via `restrictedAllow`. */
export const ARCHITECT_ALLOWED_COMMANDS = ["bsc teams", "bsc persona"];

export interface ArchitectTerminalHandle {
  /** Host element for the xterm canvas — attach to the terminal container div. */
  containerRef: RefObject<HTMLDivElement | null>;
}

/** The team-architect persona's start prompt — the store copy (user edits win), else the packaged seed. */
function architectStartPrompt(): string {
  const fromStore = useAppStore.getState().personas.find((p) => p.id === "persona-architect");
  return (fromStore ?? BUILTIN_PERSONAS.find((p) => p.id === "persona-architect"))?.startPrompt ?? "";
}

export function useArchitectTerminal(visible: boolean): ArchitectTerminalHandle {
  // The whole xterm + PTY lifecycle (terminal literal, subscribe-before-create ordering,
  // ResizeObserver, refit, cleanup) lives in the shared hook; this wrapper owns only the ARCHITECT
  // launch path + the tunnel-roster registration. pty_kill runs only in the shared cleanup.
  const { containerRef } = useScreenSession({
    paneId:    ARCHITECT_PANE_ID,
    termTheme: TERM_THEME,
    visible,
    exitBanner: "\r\n\x1b[33m[architect session ended — reopen the panel to restart]\x1b[0m\r\n",

    launch: async (term) => {
      // The workspace: ~/.base-studio-code/teams-studio/ + its architect-spec CLAUDE.md.
      const paths = await safeInvoke<{ teams_dir: string } | null>(
        "setup_architect_workspace", undefined, null,
        (e: unknown) => console.error("architect workspace setup failed:", e),
      );
      if (!paths?.teams_dir) return; // no cwd → don't launch an ungated session (#1819)

      // Role gate (#219) + the restricted allow-list (#2755): the architect is `none` on every axis —
      // git/gh denied outright, every file-write tool denied, WebFetch/WebSearch denied, `bsc ui`
      // denied (ui:none) — and `restrictedAllow` suppresses the baseline command tiers so ONLY
      // `bsc teams` + `bsc persona` auto-run. `replacePermissions` keeps the computed set authoritative.
      const cap = roleCapability("architect");
      const write = roleWriteRules(cap);
      await safeInvoke("ensure_session_settings", {
        cwd:             paths.teams_dir,
        allowedCommands: ARCHITECT_ALLOWED_COMMANDS,
        deniedCommands:  roleDeniedCommands(cap),
        allowToolRules:  [...write.allow, "Read"],
        denyToolRules:   [...write.deny, ...roleDeniedTools(cap)],
        restrictedAllow: true,
        replacePermissions: true,
      }, undefined, (e: unknown) => console.error("architect session settings failed:", e));

      // Launch claude in the workspace with the persona's start prompt BAKED into the launch arg
      // (fresh-only: the backend drops it on a `--continue` resume, so returning isn't re-greeted).
      await safeInvoke("pty_create", {
        paneId:  ARCHITECT_PANE_ID,
        cols:    term.cols,
        rows:    term.rows,
        cwd:     paths.teams_dir,
        initCmd: "claude --continue 2>/dev/null || claude",
        startupPrompt: architectStartPrompt() || undefined,
        startupPromptFreshOnly: true,
        continueSession: true,
        // The runtime scope doc (#2470): the architect renders `ui: "none"` — it never touches the kit
        // store (that's the designer). Every other role-gated launch renders `read` or `write` here.
        env: { BSC_SCOPES: JSON.stringify(sessionScopes(cap)) },
      }, undefined, console.error);

      // Session roster (#2497): register the architect session so a paired phone lists it alongside
      // the console/fleet/planner/designer panes. Registering is plain store state — useTunnelSync
      // flattens the registry and only pushes while the relay runs, so this is inert without a tunnel.
      // Unregistered in the unmount cleanup (the pty_kill site).
      useAppStore.getState().registerTunnelPanes("architect", [{
        id: ARCHITECT_PANE_ID, cwd: paths.teams_dir, name: "Teams Studio",
        status: "running", kind: "architect",
      }]);
    },

    onUnmount: () => {
      useAppStore.getState().registerTunnelPanes("architect", []); // roster (#2497)
    },
  });

  return { containerRef };
}
