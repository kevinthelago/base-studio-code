/**
 * Decide which command (if any) to bake into a fresh PTY shell at pane mount.
 *
 * Inputs cover the three layered intents:
 *  - `explicit`: a per-pane `initCmd` override (used by the triage flow before
 *    it moved to `startupPrompt`, and still legal for internal callers).
 *  - `startupPrompt`: when set (triage / fleet kickoff), `pty_create`'s backend
 *    handles the claude launch with the baked prompt — we must NOT also inject
 *    `claude --continue` as init_cmd, or we'd race two claude invocations.
 *  - `paneWasClaude` + `autoResumeClaude` + `wasUncleanShutdown` + `restoreRequested`:
 *    the resume path (#36/#1041). Mount the pane straight into `claude --continue` so
 *    the prior conversation resumes — but ONLY as crash recovery: a clean quit leaves
 *    sessions dormant. Resume when the user clicked "restore" in the crash banner
 *    (`restoreRequested`), OR when they've opted into silent auto-resume
 *    (`autoResumeClaude`) AND the last shutdown was unclean (`wasUncleanShutdown`).
 *    #3937: the `--continue` is emitted with a `|| claude` SHELL fallback. The Rust-side history
 *    guard (#124) lives on `plan_launch`'s PROMPT arm only — the INIT arm (which is what an init
 *    cmd like this takes) passes the string verbatim, so the guard never applied here despite this
 *    doc once claiming it did. A `claude --continue` with no conversation exits 1 having written
 *    ZERO bytes to stdout, which is why a resumed pane looked like a dead `$` prompt rather than a
 *    failed command. The fallback starts a fresh session instead, and works regardless of who is
 *    right about whether history exists.
 */

/** `claude --continue`, degrading to a fresh session when there is no conversation to resume (#3937).
 *  Mirrors the studio sessions' long-standing fallback; `launch.rs`'s own test constant already
 *  assumed this shape. stderr is dropped because claude's "no session" error is expected here. */
const CONTINUE_OR_FRESH = "claude --continue 2>/dev/null || claude";
export function resolveInitCmd(args: {
  explicit: string | undefined;
  startupPrompt: string | undefined;
  /** The pane was launched by a fleet/triage RESUME (`paneContinue`, #3928) — it should pick its
   *  conversation back up. Distinct from the crash-recovery flags below: this is an explicit,
   *  user-initiated resume of a session we know existed, not a guess after an unclean shutdown. */
  continueSession: boolean;
  paneWasClaude: boolean;
  autoResumeClaude: boolean;
  wasUncleanShutdown: boolean;
  restoreRequested: boolean;
}): string {
  const { explicit, startupPrompt, continueSession, paneWasClaude, autoResumeClaude, wasUncleanShutdown, restoreRequested } = args;
  // Explicit overrides win unconditionally — caller knows best.
  if (explicit && explicit.length > 0) return explicit;
  // Triage / fleet launches claude via the prompt-baked path; layering an
  // init_cmd on top would spawn a second claude before the first finishes
  // initialising.
  if (startupPrompt !== undefined) return "";
  // #3928: an explicit fleet/triage RESUME. Without this the flag died in the gap between layers —
  // `fleetStartProject` set `paneContinue`, `TerminalView` forwarded it as `continueSession`, and
  // `plan_launch` then discarded it, because it only reads that flag on the PROMPT arm. A resume
  // carries no startup prompt (that's a kickoff), so the plan fell through to `None` and the pane
  // came up as a bare bash shell: `has_history=true · resumed=false`. Every fleet relaunch was
  // silently starting cold. Placed AFTER the startupPrompt branch so a kickoff still wins.
  // #3986: `continueSession` ALONE. This used to require `paneWasClaude` too, which deadlocked: that
  // flag is set only when claude actually starts (the `claude()` wrapper's OSC 100 `run`), so a pane
  // where claude had never started could never be resumed INTO claude — the gate blocked the launch,
  // the launch was what would have set the flag. Measured: 77 of 78 fleet panes had no
  // `paneWasClaude`, i.e. Resume could not start an agent in any of them, which is the whole of the
  // "sessions come up as bare shells" thread.
  //
  // Safe to drop on both sides. `continueSession` comes from `paneContinue`, set by
  // `fleetStartProject` for FLEET panes, and the call site already forces it false for a manual
  // console (`manual ? false : …`) — so the guard excluded nothing a manual pane needed. And
  // CONTINUE_OR_FRESH degrades on its own (`--continue … || claude`, #3937), so a pane with no prior
  // conversation starts fresh rather than failing: `paneWasClaude` was guarding a case the command
  // already handles.
  if (continueSession) return CONTINUE_OR_FRESH;
  // The resume path — crash recovery only (#1041): a clean quit does NOT auto-resume.
  if (paneWasClaude && (restoreRequested || (autoResumeClaude && wasUncleanShutdown))) {
    return CONTINUE_OR_FRESH;
  }
  return "";
}
