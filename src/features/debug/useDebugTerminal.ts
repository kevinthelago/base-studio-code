// useDebugTerminal (#3298, epic #3260) — the app-owned DEBUG session: a full-capability Claude session
// in the base-studio-code SOURCE tree that works the `bsc request` improvement queue (the designer files
// the requests; this session fixes the `bsc ui` gaps behind them). Modeled on useDesignerTerminal, but
// the INVERSE permission posture:
//   • cwd — the repo root from the `debug_repo_root` command. None on a shipped binary (the source tree
//     isn't on the machine) → don't launch; the window shows an "unavailable" line.
//   • NO role gate — a role-less launch is unrestricted (baseline broad allow-list), and `bypass: true`
//     auto-runs everything (hooks-only gating). The always-on hook FLOOR still binds: the dangerous-
//     command deny, FS confinement to the repo cwd, and the `.claude` write-deny. So it can Read/Edit/
//     Write across the codebase and run git/gh/cargo/npm without prompting — the point of a debug session.
//   • startup prompt — an inline charter (below): work the request queue, fix `bsc ui`, BRANCH-ONLY.
//   • resume — `continueSession` + `claude --continue || claude`, so a reopened window resumes the
//     prior conversation (the prompt is fresh-only: dropped on a resume).
import { type RefObject } from "react";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { useScreenSession } from "@/shared/lib/session/useScreenSession";
import { DEBUG_STUDIO_SESSION_ID } from "@/shared/lib/session/systemSessions";

/** The debug session's stable pane id — one global, app-owned session (excluded from crash recovery
 *  via systemSessions, like the designer/librarian/architect). */
export const DEBUG_PANE_ID = DEBUG_STUDIO_SESSION_ID;

/** xterm ITheme for the debug terminal — inline (a plain literal structurally satisfies ITheme) so the
 *  feature doesn't reach across into the planner's theme leaf. Matches the SessionDock host bg. */
const DEBUG_TERM_THEME = { background: "#181a1f", foreground: "#e6e6e6", cursor: "#c9d1d9" };

/** The inline charter baked into the launch (fresh-only). */
const DEBUG_START_PROMPT =
  "You are the base-studio-code DEBUG session. You have full read/write access to THIS repository and " +
  "run the normal dev workflow. Your job: improve the `bsc ui` surface so the Design Studio's designer " +
  "session never needs permissions outside it. Work the improvement queue — run `bsc request list --open`, " +
  "pick a request (each cites the exact `bsc ui` command that failed), reproduce it, implement the fix in " +
  "crates/bsc-ui with tests, verify the gate (cargo check + clippy --all-targets + typecheck/lint for any " +
  "frontend), then `bsc request resolve <id> --note \"<what changed>\"` and rebuild the sidecar with " +
  "`cargo build --release --bin bsc` so the running app picks it up. Do your work in a git worktree under " +
  "`.claude/worktrees/<branch>/` on a branch off develop and open a PR — NEVER commit/push to develop or " +
  "main directly, and never switch the main checkout off develop. Start by listing the open requests.";

export interface DebugTerminalHandle {
  /** Host element for the xterm canvas — attach to the terminal container. */
  containerRef: RefObject<HTMLDivElement | null>;
}

export function useDebugTerminal(visible: boolean): DebugTerminalHandle {
  const { containerRef } = useScreenSession({
    paneId:    DEBUG_PANE_ID,
    termTheme: DEBUG_TERM_THEME,
    visible,
    exitBanner: "\r\n\x1b[33m[debug session ended — toggle it off/on in Settings to restart]\x1b[0m\r\n",

    launch: async (term) => {
      // The source tree the debug session works in. None on a machine that didn't build this binary
      // (a shipped install) → don't launch an ungated session against a missing cwd.
      const repoRoot = await safeInvoke<string | null>(
        "debug_repo_root", undefined, null,
        (e: unknown) => console.error("debug_repo_root failed:", e),
      );
      if (!repoRoot) {
        term.write("\r\n\x1b[33m[debug session unavailable — no source tree on this machine]\x1b[0m\r\n");
        return;
      }

      // FULL capability: role-less (no denies; the baseline broad allow-list stands) + bypass (auto-run
      // everything). replacePermissions stays false so the baseline allow-list is kept, not replaced.
      await safeInvoke("ensure_session_settings", {
        cwd:             repoRoot,
        allowedCommands: [],
        deniedCommands:  [],
        bypass:          true,
      }, undefined, (e: unknown) => console.error("debug session settings failed:", e));

      await safeInvoke("pty_create", {
        paneId:  DEBUG_PANE_ID,
        cols:    term.cols,
        rows:    term.rows,
        cwd:     repoRoot,
        initCmd: "claude --continue 2>/dev/null || claude",
        startupPrompt: DEBUG_START_PROMPT,
        startupPromptFreshOnly: true,
        continueSession: true,
      }, undefined, console.error);
    },
  });

  return { containerRef };
}
