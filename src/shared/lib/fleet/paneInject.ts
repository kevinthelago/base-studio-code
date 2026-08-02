// Shared app-to-agent message injection (#375). We deliver coordination messages by typing
// into a live claude pane's stdin; doing that naively dumps the text character-by-character
// into the TUI input box, where it interleaves with the TUI's own rendering and reads as a
// garbled wall of text. Wrapping it in BRACKETED PASTE markers makes the terminal hand the
// whole string to the TUI as a single atomic paste (Claude Code shows a "[Pasted text]"
// chip), after which Enter submits it cleanly. Built from char codes so no literal escape
// bytes live in the source. Used by the director pump, CI watcher, and coordinator wakes.
import { safeInvoke } from "@/shared/lib/core/safeInvoke";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const PASTE_START = ESC + "[200~";
const PASTE_END = ESC + "[201~";

/** How long to let the TUI settle after ESC before pasting. The dialog tears down and the composer
 *  re-renders; pasting into that gap puts the text nowhere. Same order as the paste→Enter gap below. */
const DISMISS_SETTLE_MS = 80;

/**
 * Inject `text` into a pane as one atomic bracketed paste, then submit with a SEPARATE Enter.
 * The two must be separate writes with a small gap: Claude Code debounces a paste, so a CR
 * glued onto the same write is swallowed as content (a trailing newline) instead of being
 * treated as the submit keypress — which left the message sitting in the input box unsent.
 *
 * `clearPending` (#4253) sends ESC first, for a pane that may be STOPPED on a permission dialog.
 * Everything above assumes the pane is sitting in its composer; a blocked one is not. The paste
 * lands in the dialog instead, and the Enter CONFIRMS WHATEVER OPTION IS HIGHLIGHTED — so a
 * director redirect was swallowed while the coordination log recorded it as delivered, and the
 * submit keypress could answer a permission question nobody read. ESC returns Claude Code to its
 * composer, after which the normal path works as designed.
 *
 * It is OPT-IN rather than the default because ESC on a pane mid-turn INTERRUPTS that turn. That is
 * exactly right for a redirect and wrong for a passive coordination message, so the two cannot share
 * one default — see `injectRedirect` for the interrupting form.
 */
export async function injectPrompt(
  paneId: string,
  text: string,
  opts?: { clearPending?: boolean },
): Promise<void> {
  if (opts?.clearPending) {
    await safeInvoke("pty_write", { paneId, data: ESC }, undefined);
    await new Promise((r) => setTimeout(r, DISMISS_SETTLE_MS));
  }
  await safeInvoke("pty_write", { paneId, data: PASTE_START + text + PASTE_END }, undefined);
  await new Promise((r) => setTimeout(r, 60));
  await safeInvoke("pty_write", { paneId, data: CR }, undefined);
}

/**
 * Inject work that must LAND — dismissing a pending permission dialog (and interrupting a running
 * turn) first. The form for a director redirect or a wake: the point is to change what the session is
 * doing, so leaving it parked on its old prompt defeats the delivery.
 *
 * Use plain {@link injectPrompt} for a passive message that should queue behind the current turn.
 */
export async function injectRedirect(paneId: string, text: string): Promise<void> {
  return injectPrompt(paneId, text, { clearPending: true });
}
