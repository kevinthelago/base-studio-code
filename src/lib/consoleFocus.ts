// Focus policy for console panes.

export type PaneStatus = "run" | "on" | "idle";

/**
 * Milliseconds after a triage/quick-start tab launches during which auto-focus
 * is suppressed. Long enough for a grid of cold-starting agents to settle so
 * their *initial* idles don't yank the cursor around. Tuned to cover a ~16-pane
 * cold start; adjust if larger grids still flicker. After this window, normal
 * focus-stealing resumes.
 */
export const STARTUP_GRACE_MS = 20000;

/**
 * Cooldown after an auto-focus steal during which a *different* pane settling to
 * idle won't steal the cursor again. Without it, two agents finishing in quick
 * succession (amplified by the quiet-timer flipping panes run↔idle repeatedly)
 * ping-pong the cursor between them. Short enough that genuinely sequential
 * finishes a couple seconds apart still each surface; long enough to absorb a
 * burst. The first idle in a quiet stretch is never gated.
 */
export const AUTOFOCUS_COOLDOWN_MS = 1500;

/**
 * Whether a pane that just transitioned run -> idle should auto-grab focus.
 *
 * Auto-focus is *meant* to steal: when an agent finishes and needs direction the
 * cursor jumps there so you can reply fast — core to driving many agents at
 * once. Two exceptions suppress it:
 *  - the startup phase, while a freshly-launched triage grid is still
 *    cold-starting and every pane's first settle would yank the cursor around
 *    the grid (see {@link STARTUP_GRACE_MS});
 *  - a cooldown right after a previous steal, so competing near-simultaneous
 *    idles don't ping-pong the cursor (see {@link AUTOFOCUS_COOLDOWN_MS}).
 * Manual focus (clicking a pane) is never gated.
 *
 * @param msSinceLastAutoFocus ms since the last auto-focus steal; defaults to
 *   Infinity (no prior steal → cooldown never applies).
 */
export function shouldAutoFocusOnIdle(
  autoFocus: boolean,
  status: PaneStatus,
  prevStatus: PaneStatus,
  withinStartupGrace: boolean,
  msSinceLastAutoFocus: number = Infinity,
): boolean {
  if (!autoFocus || status !== "idle" || prevStatus !== "run") return false;
  if (withinStartupGrace) return false;
  if (msSinceLastAutoFocus < AUTOFOCUS_COOLDOWN_MS) return false;
  return true;
}
