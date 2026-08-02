// Shared wake actuation (#199): kill the parked pane, relaunch it fresh via the store's
// wakePane, then record the `woke` event so it isn't offered again. Used by both the
// inbox "Wake" button and the always-on auto-wake coordinator.
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { injectRedirect } from "./paneInject";

export async function actuateWake(
  session: string,
  prompt: string,
  wakePane: (paneId: string, prompt: string) => boolean,
): Promise<boolean> {
  // Kill first so the runId-bump remount spawns a FRESH session (not a reconnect).
  await safeInvoke("pty_kill", { paneId: session }, undefined);
  const ok = wakePane(session, prompt);
  if (ok) await safeInvoke("append_coord_woke", { session }, undefined);
  return ok;
}

/**
 * Deliver a wake to a LIVE (parked) session by injecting the prompt straight into its pane
 * (#374) — instant, keeps the session's own context, and consistent with how the director
 * pump + CI watcher deliver. Records the `woke` event so it isn't re-fired. This is the
 * automatic path; the manual inbox button still uses actuateWake (a fresh relaunch).
 */
export async function injectWake(session: string, prompt: string): Promise<boolean> {
  // `injectRedirect`, not `injectPrompt` (#4253): a PARKED session is frequently parked ON a permission
  // dialog, and a plain paste lands in that dialog rather than the composer — so the wake was recorded
  // as delivered while the session never moved. Clearing first is the whole point of a wake.
  await injectRedirect(session, prompt);
  await safeInvoke("append_coord_woke", { session }, undefined);
  return true;
}
