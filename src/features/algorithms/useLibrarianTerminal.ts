// useLibrarianTerminal (#2787) — the Algorithms tab's dedicated, heavily-restricted knowledge-store
// session. A near-verbatim mirror of the Teams Studio's `useArchitectTerminal` (#2755): the same
// xterm + PTY lifecycle (via the shared `useScreenSession`), `ensure_session_settings` before launch,
// and `pty_create` with the startup prompt BAKED into the launch arg (never typed after idle
// detection — the established rule). Every invoke/pty_create arg shape is identical to the architect's;
// only the command surface, role, workspace, and persona differ.
//
// What makes it the LIBRARIAN session:
//   • cwd — the global `~/.base-studio-code/algorithms-studio/` workspace (`setup_librarian_workspace`
//     creates it + writes the librarian-spec CLAUDE.md from the packaged seed).
//   • role gate — `roleCapability("librarian")` (#219): none on every axis (incl. `ui: none` — it is
//     NOT a UI-kit session). Its git/gh denies + write-tool denies + web-tool denies are rendered
//     into the session settings.
//   • restricted allow-list — `restrictedAllow: true` suppresses the baseline command tiers, so the
//     session's ENTIRE auto-runnable surface is `bsc graph` (the knowledge-graph CLI).
//   • startup prompt — the built-in knowledge-librarian persona's startPrompt (user-editable via Personas).
//   • resume — `continueSession` + a `claude --continue` init, like the architect, so a relaunch
//     resumes the prior conversation.
//
// The generic console TerminalView is deliberately NOT reused (pane-system baggage); this hook tears
// the session down when the panel unmounts — which, since the Algorithms tab is kept mounted across tab
// switches (#2827), now happens only on app shutdown (or a tear-off ownership release), not on leaving
// the tab.
import { type RefObject } from "react";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import {
  roleCapability,
  roleDeniedCommands,
  roleDeniedTools,
  roleWriteRules,
  sessionScopes,
  restrictedRoleCommands,
} from "@/shared/lib/session/sessionRoles";
import { useScreenSession } from "@/shared/lib/session/useScreenSession";
import { BUILTIN_PERSONAS } from "@/features/personas";
// The shared xterm terminal theme, sourced from the console's canonical constants (a lint-clean
// feature→app import, exactly as the tunnel + teams features do) rather than duplicating the literal.
import { TERM_THEME } from "@/app/console/lib/terminalConstants";
import { ALGORITHMS_STUDIO_SESSION_ID } from "@/shared/lib/session/systemSessions";

/** The librarian session's stable pane id — one global, app-owned session (#3137: the single source of
 *  truth lives in `systemSessions`, so crash recovery excludes it). */
export const LIBRARIAN_PANE_ID = ALGORITHMS_STUDIO_SESSION_ID;

/** The librarian's whole command surface: `bsc graph` (the algorithms knowledge graph — nodes,
 *  relationships, the per-tech impl tier, and the extraction lens), emitted as the session's ONLY
 *  `Bash(<cmd> *)` allow via `restrictedAllow`. */
export const LIBRARIAN_ALLOWED_COMMANDS = restrictedRoleCommands("librarian");

export interface LibrarianTerminalHandle {
  /** Host element for the xterm canvas — attach to the terminal container div. */
  containerRef: RefObject<HTMLDivElement | null>;
}

/** The knowledge-librarian persona's start prompt — the store copy (user edits win), else the seed. */
function librarianStartPrompt(): string {
  const fromStore = useAppStore.getState().personas.find((p) => p.id === "persona-librarian");
  return (fromStore ?? BUILTIN_PERSONAS.find((p) => p.id === "persona-librarian"))?.startPrompt ?? "";
}

export function useLibrarianTerminal(visible: boolean): LibrarianTerminalHandle {
  // The whole xterm + PTY lifecycle (terminal literal, subscribe-before-create ordering,
  // ResizeObserver, refit, cleanup) lives in the shared hook; this wrapper owns only the LIBRARIAN
  // launch path + the tunnel-roster registration. pty_kill runs only in the shared cleanup.
  const { containerRef } = useScreenSession({
    paneId:    LIBRARIAN_PANE_ID,
    termTheme: TERM_THEME,
    visible,
    exitBanner: "\r\n\x1b[33m[librarian session ended — reopen the panel to restart]\x1b[0m\r\n",

    launch: async (term) => {
      // The workspace: ~/.base-studio-code/algorithms-studio/ + its librarian-spec CLAUDE.md.
      const paths = await safeInvoke<{ algorithms_dir: string } | null>(
        "setup_librarian_workspace", undefined, null,
        (e: unknown) => console.error("librarian workspace setup failed:", e),
      );
      if (!paths?.algorithms_dir) return; // no cwd → don't launch an ungated session (#1819)

      // Role gate (#219) + the restricted allow-list (#2787): the librarian is `none` on every axis —
      // git/gh denied outright, every file-write tool denied, WebFetch/WebSearch denied, `bsc ui`
      // denied (ui:none) — and `restrictedAllow` suppresses the baseline command tiers so ONLY
      // `bsc graph` auto-runs. `replacePermissions` keeps the computed set authoritative.
      const cap = roleCapability("librarian");
      const write = roleWriteRules(cap);
      await safeInvoke("ensure_session_settings", {
        cwd:             paths.algorithms_dir,
        allowedCommands: LIBRARIAN_ALLOWED_COMMANDS,
        deniedCommands:  roleDeniedCommands(cap),
        allowToolRules:  [...write.allow, "Read"],
        denyToolRules:   [...write.deny, ...roleDeniedTools(cap)],
        restrictedAllow: true,
        replacePermissions: true,
      }, undefined, (e: unknown) => console.error("librarian session settings failed:", e));

      // Launch claude in the workspace with the persona's start prompt BAKED into the launch arg
      // (fresh-only: the backend drops it on a `--continue` resume, so returning isn't re-greeted).
      await safeInvoke("pty_create", {
        paneId:  LIBRARIAN_PANE_ID,
        cols:    term.cols,
        rows:    term.rows,
        cwd:     paths.algorithms_dir,
        initCmd: "claude --continue 2>/dev/null || claude",
        startupPrompt: librarianStartPrompt() || undefined,
        startupPromptFreshOnly: true,
        continueSession: true,
        // The runtime scope doc (#2470): the librarian renders `ui: "none"` — it never touches the kit
        // store (that's the designer).
        env: { BSC_SCOPES: JSON.stringify(sessionScopes(cap)) },
      }, undefined, console.error);

      // Session roster (#2497): register the librarian session so a paired phone lists it alongside the
      // console/fleet/planner/designer/architect panes. Registering is plain store state — useTunnelSync
      // flattens the registry and only pushes while the relay runs, so this is inert without a tunnel.
      // Unregistered in the unmount cleanup (the pty_kill site).
      useAppStore.getState().registerTunnelPanes("librarian", [{
        id: LIBRARIAN_PANE_ID, cwd: paths.algorithms_dir, name: "Algorithms Studio",
        status: "running", kind: "librarian",
      }]);
    },

    onUnmount: () => {
      useAppStore.getState().registerTunnelPanes("librarian", []); // roster (#2497)
    },
  });

  return { containerRef };
}
