// useDesignerTerminal (#2471) — the Design Studio's dedicated, heavily-restricted UI-kit session.
// Modeled closely on the planner's terminal hook (`usePlannerTerminal`, #1775): xterm + FitAddon +
// the shared TERM_THEME, `ensure_session_settings` before launch, `pty_create` with the startup
// prompt BAKED into the launch arg (never typed after idle detection — the established rule).
//
// What makes it the DESIGNER session:
//   • cwd — the global `~/.base-studio-code/design-studio/` workspace (`setup_designer_workspace`
//     creates it + writes the designer-spec CLAUDE.md from the packaged seed).
//   • role gate — `roleCapability("designer")` (#219): none on every axis. Its git/gh denies +
//     write-tool denies + web-tool denies are rendered into the session settings.
//   • restricted allow-list — `restrictedAllow: true` suppresses the baseline command tiers, so the
//     session's ENTIRE auto-runnable surface is `bsc ui` (+ the deprecated `bsc component` alias,
//     so the session works before AND after the #2469 merge).
//   • startup prompt — the built-in designer persona's startPrompt (user-editable via Personas).
//   • resume — `continueSession` + a `claude --continue || claude` init, like the planner, so a
//     relaunch resumes the prior conversation.
//
// The generic console TerminalView is deliberately NOT reused (pane-system baggage); collapsing the
// panel only CSS-hides the mounted host, so the PTY survives — this hook tears the session down
// only when the Design Studio itself unmounts.
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
// Deep import of the planner's pure terminal-theme leaf (no React, no planner state): pulling the
// whole planner barrel here would cycle (planner → FocusedBodies → @/features/designs → Design
// Studio → planner). `components` is an exempt importer (#2197) while its restructure lands.
import { TERM_THEME } from "@/features/planner/session/planningTerminal";
import { DESIGN_STUDIO_SESSION_ID } from "@/shared/lib/session/systemSessions";

/** The designer session's stable pane id — one global, app-owned session (#3137: the single source of
 *  truth lives in `systemSessions`, so crash recovery excludes it). */
export const DESIGNER_PANE_ID = DESIGN_STUDIO_SESSION_ID;

/** The designer's whole command surface, emitted as the session's ONLY `Bash(<cmd> *)` allows via
 *  `restrictedAllow` — each entry is a PREFIX, so `"bsc ui"` auto-runs EVERY `bsc ui` subcommand
 *  (theme/tokens/resolve/generate/doctor/…). `bsc component` is the deprecated `bsc ui` alias (#2469).
 *  `bsc shot` (#3261) captures the running app's pixels and `bsc loop` (#3262) drives the design loop —
 *  both must AUTO-RUN so the loop (#3292) iterates unattended (`bsc loop say` + `bsc shot` per turn).
 *  `bsc request new`/`bsc request list` (#3300) is the designer→debug channel — on a `bsc ui` wall it
 *  FILES a request for the debug session to fix (#3298) instead of asking for out-of-surface
 *  permissions; `resolve` is deliberately NOT here (draining the queue is the debug session's contract). */
export const DESIGNER_ALLOWED_COMMANDS = ["bsc ui", "bsc component", "bsc shot", "bsc loop", "bsc request new", "bsc request list"];

export interface DesignerTerminalHandle {
  /** Host element for the xterm canvas — attach to the terminal container div. */
  containerRef: RefObject<HTMLDivElement | null>;
}

/** The designer persona's start prompt — the store copy (user edits win), else the packaged seed. */
function designerStartPrompt(): string {
  const fromStore = useAppStore.getState().personas.find((p) => p.id === "persona-designer");
  return (fromStore ?? BUILTIN_PERSONAS.find((p) => p.id === "persona-designer"))?.startPrompt ?? "";
}

export function useDesignerTerminal(visible: boolean): DesignerTerminalHandle {
  // The whole xterm + PTY lifecycle (terminal literal, subscribe-before-create ordering,
  // ResizeObserver, refit, cleanup) lives in the shared hook; this wrapper owns only the DESIGNER
  // launch path + the tunnel-roster registration. pty_kill runs only in the shared cleanup — panel
  // collapse merely hides the host, so the session keeps running.
  const { containerRef } = useScreenSession({
    paneId:    DESIGNER_PANE_ID,
    termTheme: TERM_THEME,
    visible,
    exitBanner: "\r\n\x1b[33m[designer session ended — reopen the panel to restart]\x1b[0m\r\n",

    launch: async (term) => {
      // The workspace: ~/.base-studio-code/design-studio/ + its designer-spec CLAUDE.md.
      const paths = await safeInvoke<{ design_dir: string } | null>(
        "setup_designer_workspace", undefined, null,
        (e: unknown) => console.error("designer workspace setup failed:", e),
      );
      if (!paths?.design_dir) return; // no cwd → don't launch an ungated session (#1819)

      // Role gate (#219) + the restricted allow-list (#2471): the designer is `none` on every axis —
      // git/gh denied outright, every file-write tool denied, WebFetch/WebSearch denied — and
      // `restrictedAllow` suppresses the baseline command tiers so ONLY `bsc ui` (+ the deprecated
      // `bsc component` alias) auto-runs. `replacePermissions` keeps the computed set authoritative.
      const cap = roleCapability("designer");
      const write = roleWriteRules(cap);
      await safeInvoke("ensure_session_settings", {
        cwd:             paths.design_dir,
        allowedCommands: DESIGNER_ALLOWED_COMMANDS,
        deniedCommands:  roleDeniedCommands(cap),
        allowToolRules:  [...write.allow, "Read"],
        denyToolRules:   [...write.deny, ...roleDeniedTools(cap)],
        restrictedAllow: true,
        replacePermissions: true,
      }, undefined, (e: unknown) => console.error("designer session settings failed:", e));

      // Launch claude in the workspace with the persona's start prompt BAKED into the launch arg
      // (fresh-only: the backend drops it on a `--continue` resume, so returning isn't re-greeted).
      await safeInvoke("pty_create", {
        paneId:  DESIGNER_PANE_ID,
        cols:    term.cols,
        rows:    term.rows,
        cwd:     paths.design_dir,
        initCmd: "claude --continue 2>/dev/null || claude",
        startupPrompt: designerStartPrompt() || undefined,
        startupPromptFreshOnly: true,
        continueSession: true,
        // The runtime scope doc (#2470): `ui: "write"` — the designer is the one role the store
        // CLI lets mutate; every other role-gated launch renders `read` here.
        env: { BSC_SCOPES: JSON.stringify(sessionScopes(cap)) },
      }, undefined, console.error);

      // Session roster (#2497): register the designer session so a paired phone lists it
      // alongside the console/fleet/planner panes. Registering is plain store state —
      // useTunnelSync flattens the registry and only pushes while the relay runs, so this
      // is inert without a tunnel. Unregistered in the unmount cleanup (the pty_kill site).
      useAppStore.getState().registerTunnelPanes("designer", [{
        id: DESIGNER_PANE_ID, cwd: paths.design_dir, name: "Design Studio",
        status: "running", kind: "designer",
      }]);
    },

    onUnmount: () => {
      useAppStore.getState().registerTunnelPanes("designer", []); // roster (#2497)
    },
  });

  return { containerRef };
}
