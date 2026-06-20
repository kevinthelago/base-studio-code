/**
 * Decide which command (if any) to bake into a fresh PTY shell at pane mount.
 *
 * Inputs cover the three layered intents:
 *  - `explicit`: a per-pane `initCmd` override (used by the triage flow before
 *    it moved to `startupPrompt`, and still legal for internal callers).
 *  - `startupPrompt`: when set (triage / fleet kickoff), `pty_create`'s backend
 *    handles the claude launch with the baked prompt — we must NOT also inject
 *    `claude --continue` as init_cmd, or we'd race two claude invocations.
 *  - `paneWasClaude` + `autoResumeClaude`: the #36 ad-hoc-pane resume path.
 *    When the user had claude running here at last shutdown and hasn't opted
 *    out of auto-resume, mount the pane straight into `claude --continue` so
 *    the prior conversation resumes. The Rust side already guards `--continue`
 *    against missing history (#124), so a stale flag falls back gracefully.
 */
export function resolveInitCmd(args: {
  explicit: string | undefined;
  startupPrompt: string | undefined;
  paneWasClaude: boolean;
  autoResumeClaude: boolean;
}): string {
  const { explicit, startupPrompt, paneWasClaude, autoResumeClaude } = args;
  // Explicit overrides win unconditionally — caller knows best.
  if (explicit && explicit.length > 0) return explicit;
  // Triage / fleet launches claude via the prompt-baked path; layering an
  // init_cmd on top would spawn a second claude before the first finishes
  // initialising.
  if (startupPrompt !== undefined) return "";
  // The ad-hoc resume path: only if the pane has used claude before AND the
  // user hasn't opted out via the Settings → Integrations toggle.
  if (paneWasClaude && autoResumeClaude) return "claude --continue";
  return "";
}
