// Terminal key remapping (#4134) — the keys xterm's defaults get wrong for an agent TUI.
//
// SHIFT+ENTER. xterm.js maps Enter to a bare CR (`\r`) and ignores modifiers, so Shift+Enter is
// byte-identical to Enter: the prompt SUBMITS where the user meant to insert a newline. That is true of
// every terminal in this app — the docked Algorithms/Components sessions and Console panes all render the
// one `TerminalView` — so it reads as page-specific but never was.
//
// The remedy is the same one Claude Code's own `/terminal-setup` installs for hosts that don't emit it
// natively. Taken from the shipped binary rather than from memory:
//
//     VS Code   "args": { "text": "\u001b\r" }
//     iTerm2    chars = "\u001B\r"
//
// i.e. ESC + CR. (iTerm2, WezTerm, Ghostty, Kitty, Warp and Windows Terminal send it natively; xterm.js
// does not, which is why we send it here.)
//
// Pure + exported so the mapping is unit-testable without a terminal, and so there is ONE definition
// rather than a magic string inside an event handler.

/** ESC + CR — the "newline, don't submit" sequence an agent TUI expects for Shift+Enter. */
export const SHIFT_ENTER_BYTES = "\x1b\r";

/** A keyboard event, narrowed to what the mapping actually reads. */
export interface TerminalKeyEvent {
  type: string;
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * The bytes this app sends INSTEAD of xterm's default for `e`, or `null` to let xterm handle it.
 *
 * Deliberately narrow: only an unmodified-apart-from-Shift **keydown** of Enter is remapped. Ctrl+Enter,
 * Alt+Enter and Meta+Enter keep whatever xterm does with them today — an agent TUI may bind those
 * separately, and silently swallowing them would trade one broken key for three.
 */
export function terminalKeyOverride(e: TerminalKeyEvent): string | null {
  if (e.type !== "keydown") return null; // the same event arrives again as keyup; remap once
  if (e.key !== "Enter") return null;
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return null;
  return SHIFT_ENTER_BYTES;
}
