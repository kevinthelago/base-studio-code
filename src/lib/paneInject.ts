// Shared app-to-agent message injection (#375). We deliver coordination messages by typing
// into a live claude pane's stdin; doing that naively dumps the text character-by-character
// into the TUI input box, where it interleaves with the TUI's own rendering and reads as a
// garbled wall of text. Wrapping it in BRACKETED PASTE markers makes the terminal hand the
// whole string to the TUI as a single atomic paste (Claude Code shows a "[Pasted text]"
// chip), after which Enter submits it cleanly. Built from char codes so no literal escape
// bytes live in the source. Used by the director pump, CI watcher, and coordinator wakes.
import { invoke } from "@tauri-apps/api/core";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const PASTE_START = ESC + "[200~";
const PASTE_END = ESC + "[201~";

/** Inject `text` into a pane as one atomic bracketed paste, then submit with Enter. */
export async function injectPrompt(paneId: string, text: string): Promise<void> {
  await invoke("pty_write", { paneId, data: PASTE_START + text + PASTE_END + CR }).catch(() => {});
}
