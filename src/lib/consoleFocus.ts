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
 * Whether a pane that just transitioned run -> idle should auto-grab focus.
 *
 * Auto-focus is *meant* to steal: when an agent finishes and needs direction the
 * cursor jumps there so you can reply fast — core to driving many agents at
 * once. The single exception is the startup phase: while a freshly-launched
 * triage grid is still cold-starting, every pane's first settle would yank focus
 * around the screen, so we suppress stealing until the grace window elapses (see
 * {@link STARTUP_GRACE_MS}). Manual focus (clicking a pane) is never gated.
 */
export function shouldAutoFocusOnIdle(
  autoFocus: boolean,
  status: PaneStatus,
  prevStatus: PaneStatus,
  withinStartupGrace: boolean,
): boolean {
  if (!autoFocus || status !== "idle" || prevStatus !== "run") return false;
  return !withinStartupGrace;
}
