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
import { useEffect, useRef, type RefObject, type MutableRefObject } from "react";
import { safeInvoke, fireInvoke } from "@/shared/lib/core/safeInvoke";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "@/store";
import {
  roleCapability,
  roleDeniedCommands,
  roleDeniedTools,
  roleWriteRules,
  sessionScopes,
} from "@/shared/lib/session/sessionRoles";
import { BUILTIN_PERSONAS } from "@/features/personas";
// Deep import of the planner's pure terminal-theme leaf (no React, no planner state): pulling the
// whole planner barrel here would cycle (planner → FocusedBodies → @/features/components → Design
// Studio → planner). `components` is an exempt importer (#2197) while its restructure lands.
import { TERM_THEME } from "@/features/planner/session/planningTerminal";

/** The designer session's stable pane id — one global session, keyed like `<project>:<stream>`. */
export const DESIGNER_PANE_ID = "design-studio:designer";

/** The designer's whole command surface: `bsc ui` plus the deprecated `bsc component` alias (#2469),
 *  emitted as the session's ONLY `Bash(<cmd> *)` allows via `restrictedAllow`. */
export const DESIGNER_ALLOWED_COMMANDS = ["bsc ui", "bsc component"];

export interface DesignerTerminalHandle {
  /** Host element for the xterm canvas — attach to the terminal container div. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** The live xterm instance (null before mount / after unmount). */
  termRef: MutableRefObject<Terminal | null>;
}

/** The designer persona's start prompt — the store copy (user edits win), else the packaged seed. */
function designerStartPrompt(): string {
  const fromStore = useAppStore.getState().personas.find((p) => p.id === "persona-designer");
  return (fromStore ?? BUILTIN_PERSONAS.find((p) => p.id === "persona-designer"))?.startPrompt ?? "";
}

export function useDesignerTerminal(visible: boolean): DesignerTerminalHandle {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef      = useRef<Terminal | null>(null);
  const fitRef       = useRef<FitAddon | null>(null);
  const unlistenData = useRef<UnlistenFn | null>(null);
  const unlistenExit = useRef<UnlistenFn | null>(null);

  // Mount xterm.js and spawn the designer PTY (once per Design Studio lifecycle). pty_kill runs
  // only in this cleanup — panel collapse merely hides the host, so the session keeps running.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      theme: TERM_THEME,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    termRef.current = term;
    fitRef.current  = fitAddon;

    term.onData((data) => {
      fireInvoke("pty_write", { paneId: DESIGNER_PANE_ID, data }, console.error);
    });

    requestAnimationFrame(async () => {
      fitAddon.fit();

      // Subscribe before creating the PTY so we never miss early output.
      unlistenData.current = await listen<string>(`pty_data_${DESIGNER_PANE_ID}`, (ev) => {
        term.write(ev.payload);
      });
      unlistenExit.current = await listen<unknown>(`pty_exit_${DESIGNER_PANE_ID}`, () => {
        term.write("\r\n\x1b[33m[designer session ended — reopen the panel to restart]\x1b[0m\r\n");
      });

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
    });

    const ro = new ResizeObserver(() => {
      // A hidden (collapsed) panel is display:none → zero client size, skipped here.
      const { clientWidth, clientHeight } = el;
      if (clientWidth === 0 || clientHeight === 0) return;
      fitAddon.fit();
      fireInvoke("pty_resize", { paneId: DESIGNER_PANE_ID, cols: term.cols, rows: term.rows }, console.error);
    });
    ro.observe(el);

    return () => {
      unlistenData.current?.();
      unlistenExit.current?.();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current  = null;
      fireInvoke("pty_kill", { paneId: DESIGNER_PANE_ID }, console.error);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit when the panel becomes visible (hidden → shown): the collapsed host is display:none, so
  // the mount-time fit measured nothing. Mirror the planner's refit (frame + short delay + fonts).
  useEffect(() => {
    if (!visible) return;
    const refit = (focusToo: boolean) => {
      const fit = fitRef.current, term = termRef.current, el = containerRef.current;
      if (!fit || !term || !el || el.clientWidth === 0 || el.clientHeight === 0) return;
      fit.fit();
      fireInvoke("pty_resize", { paneId: DESIGNER_PANE_ID, cols: term.cols, rows: term.rows }, console.error);
      if (focusToo) term.focus();
    };
    let cancelled = false;
    const raf = requestAnimationFrame(() => refit(true));
    const delayed = setTimeout(() => refit(false), 120);
    document.fonts?.ready?.then(() => { if (!cancelled) refit(false); }).catch(() => {});
    return () => { cancelled = true; cancelAnimationFrame(raf); clearTimeout(delayed); };
  }, [visible]);

  return { containerRef, termRef };
}
