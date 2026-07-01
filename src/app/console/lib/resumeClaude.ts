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
 *    The Rust side guards `--continue` against missing history (#124), so a stale flag
 *    falls back gracefully.
 */
export function resolveInitCmd(args: {
  explicit: string | undefined;
  startupPrompt: string | undefined;
  paneWasClaude: boolean;
  autoResumeClaude: boolean;
  wasUncleanShutdown: boolean;
  restoreRequested: boolean;
}): string {
  const { explicit, startupPrompt, paneWasClaude, autoResumeClaude, wasUncleanShutdown, restoreRequested } = args;
  // Explicit overrides win unconditionally — caller knows best.
  if (explicit && explicit.length > 0) return explicit;
  // Triage / fleet launches claude via the prompt-baked path; layering an
  // init_cmd on top would spawn a second claude before the first finishes
  // initialising.
  if (startupPrompt !== undefined) return "";
  // The resume path — crash recovery only (#1041): a clean quit does NOT auto-resume.
  if (paneWasClaude && (restoreRequested || (autoResumeClaude && wasUncleanShutdown))) {
    return "claude --continue";
  }
  return "";
}
