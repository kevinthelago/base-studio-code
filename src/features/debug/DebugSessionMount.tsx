// DebugSessionMount (#3326, epic #3260) — the persistent host that keeps the app-owned DEBUG session's
// terminal ALIVE on the shared TerminalHost while the Settings `debugSession` flag is on, so the in-graph
// morph (the `debugger` node in the base-studio-code Glance graph, #3319/#3322) can show it. Replaces the
// old bespoke `useDebugTerminal` (its own single-mount xterm via `useScreenSession`): the terminal now
// lives on the app-level TerminalHost like every fleet terminal — re-parented INTO the Glance morph when
// the node is opened, and parked HERE (off-screen) when it's closed. The window (#3298) was removed in
// #3327; this is the terminal-architecture half of the migration.
//
// WHY A HIDDEN `primary` SLOT: TerminalHost renders a <TerminalView> for a paneId only WHILE that paneId
// has at least one claim; when the last claim (the morph) deregisters, the view unmounts and the PTY is
// torn down. A fleet terminal survives morph-close because its console GRID CELL is a permanent claim. The
// debug session has no cell — so THIS mount is its permanent `primary` claim. It:
//   • supplies the launch props (cwd + resume initCmd) as the primary, and
//   • sits OFF-SCREEN (not `display:none`, so the parked xterm still fits to a real size) — keeping the
//     PTY warm across morph open/close.
// The Glance morph drops a second, VISIBLE viewer slot (GlanceChatDock) for the same paneId; being the
// last claim it becomes the owner, so the host re-parents the live terminal into the morph on open and
// back here on close.
//
// POSTURE: the debug session is ALWAYS bypass + role-less (the unrestricted maintenance session in the
// base-studio-code source tree). That posture is NOT a store role — it's the `isFullCapabilitySession`
// carve-out in `buildSessionSettings` (bypass) + the absence of a `paneRoles` entry (role-less). So this
// mount only seeds the two ordinary Claude-launch store fields TerminalView reads: the charter and resume.
import { useEffect, useState } from "react";
import { useAppStore } from "@/store";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { Box } from "@/shared/ui/layout/Box";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { DEBUG_STUDIO_SESSION_ID } from "@/shared/lib/session/systemSessions";

/** The debug session's stable pane id — one global, app-owned session (excluded from crash recovery via
 *  systemSessions, like the designer/librarian/architect). */
export const DEBUG_PANE_ID = DEBUG_STUDIO_SESSION_ID;

/**
 * ALWAYS launch a FRESH conversation (#3497) — never `--continue`.
 *
 * This pane's cwd is the REPO ROOT, which is the same cwd every other Claude session on the machine
 * uses, and `claude --continue` resumes the most recent conversation for a **directory**, not for a
 * pane. So `--continue` here did not resume "the prior debug conversation" — it resumed whichever
 * unrelated session last ran in this repo (there were three from the same hour when this was found).
 *
 * And it failed SILENTLY in both directions: the charter below is delivered as `--initial-message`
 * FRESH-ONLY, so a resumed launch dropped it and the session was never told to work the request queue.
 * The queue then sat unread with no error anywhere — `activity.log` showed prompts submitted while
 * `audit.log` / `tokens.log` / `perm.log` had nothing at all for this pane.
 *
 * Launching fresh removes the whole class: the pane can never attach to a stranger's conversation, and
 * the charter always arrives. The cost is no continuity across restarts, which is the right trade for
 * a queue worker — it re-reads the queue on every start — and is the direction #3498 is heading anyway
 * (per-request ephemeral sessions, where continuity is explicitly not wanted).
 */
export const DEBUG_INIT_CMD = "claude";

/** The inline charter baked into the launch as `claude --initial-message`. Delivery is `fresh-only`
 *  (`resolveStartupPromptFreshOnly`), which is why {@link DEBUG_INIT_CMD} must never resume: a resumed
 *  launch drops this silently and the session runs with no idea it is the debugger (#3497). Kept
 *  verbatim from the old `useDebugTerminal`. */
export const DEBUG_START_PROMPT =
  "You are the base-studio-code DEBUG session. You have full read/write access to THIS repository and " +
  "run the normal dev workflow. Your job: improve the `bsc ui` surface so the Design Studio's designer " +
  "session never needs permissions outside it. Work the improvement queue — run `bsc request list --open`, " +
  "pick a request (each cites the exact `bsc ui` command that failed), reproduce it, implement the fix in " +
  "crates/bsc-ui with tests, verify the gate (cargo check + clippy --all-targets + typecheck/lint for any " +
  "frontend), then `bsc request resolve <id> --note \"<what changed>\"` and rebuild the sidecar with " +
  "`cargo build --release --bin bsc` so the running app picks it up. Do your work in a git worktree under " +
  "`.claude/worktrees/<branch>/` on a branch off develop and open a PR — NEVER commit/push to develop or " +
  "main directly, and never switch the main checkout off develop. Start by listing the open requests.";

/** Keeps the debug session's PTY warm on TerminalHost while `debugSession` is on. Renders nothing visible
 *  (the terminal is shown by the Glance morph); returns null when the flag is off or the source tree isn't
 *  on this machine (a shipped binary — the ungated session must never launch against a missing cwd). */
export function DebugSessionMount() {
  const debugSession = useAppStore((s) => s.debugSession);
  // undefined = still resolving; null = no source tree (shipped binary); string = the repo root cwd.
  const [repoRoot, setRepoRoot] = useState<string | null | undefined>(undefined);

  // Resolve the source tree once the session is enabled. None on a machine that didn't build this binary
  // → don't launch (the graph node simply won't open a live terminal).
  useEffect(() => {
    if (!debugSession) { setRepoRoot(undefined); return; }
    let alive = true;
    void safeInvoke<string | null>(
      "debug_repo_root", undefined, null,
      (e: unknown) => console.error("debug_repo_root failed:", e),
    ).then((root) => { if (alive) setRepoRoot(root); });
    return () => { alive = false; };
  }, [debugSession]);

  // Seed the two ordinary Claude-launch store fields TerminalView reads at pty_create: the charter (baked
  // as --initial-message) and the resume flag. Everything else about the debug session's posture comes
  // from the isFullCapabilitySession carve-out, not the store.
  //
  // `paneContinue` is FALSE (#3497). It is the flag TerminalView actually turns into `claude --continue`
  // at pty_create, so it — not just the initCmd — is what made this pane resume. Both had to change:
  // fixing only the initCmd would have left the bug fully intact. See {@link DEBUG_INIT_CMD} for why
  // resuming is wrong here at all (this pane's cwd is the shared repo root, so a resume attaches to
  // whichever unrelated session last ran in this repo, and silently drops the fresh-only charter).
  useEffect(() => {
    if (!debugSession || !repoRoot) return;
    useAppStore.setState((st) => ({
      paneStartupPromptText: { ...st.paneStartupPromptText, [DEBUG_PANE_ID]: DEBUG_START_PROMPT },
      paneContinue:          { ...st.paneContinue, [DEBUG_PANE_ID]: false },
    }));
  }, [debugSession, repoRoot]);

  if (!debugSession || !repoRoot) return null;
  return (
    // Off-screen (NOT display:none, so the hidden xterm still fits to a real size) permanent `primary`
    // claim. The morph's visible viewer slot re-parents the terminal in when the node is opened.
    <Box
      aria-hidden
      style={{
        position: "absolute", left: -99999, top: 0, width: 800, height: 600,
        overflow: "hidden", pointerEvents: "none", display: "flex", flexDirection: "column",
      }}
    >
      {/* `parked` (#3357): a holding claim never takes ownership from a real surface — it owns the terminal
          only as the last claim standing. Behaviour-identical here (the morph is the only other claimant),
          and it keeps every app-owned session mount on the same rule. */}
      <TerminalSlot paneId={DEBUG_PANE_ID} primary parked visible={false} initialCwd={repoRoot} initCmd={DEBUG_INIT_CMD} />
    </Box>
  );
}
