// Planner terminal/ANSI helpers, split out of Planning.tsx (#1332): the xterm theme, the
// ANSI-escape stripper, and a viewport-content probe used to avoid re-sending an already-pasted prompt.
import type { Terminal } from "@xterm/xterm";

export const TERM_THEME: import("@xterm/xterm").ITheme = {
  background:          "#181a1f",
  foreground:          "#eeeae4",
  cursor:              "#c4923a",
  cursorAccent:        "#181a1f",
  selectionBackground: "#c4923a44",
  black:               "#181a1f", brightBlack:   "#44474f",
  red:                 "#d4554f", brightRed:     "#e06c75",
  green:               "#5fb467", brightGreen:   "#98c379",
  yellow:              "#c4923a", brightYellow:  "#e5c07b",
  blue:                "#5694c7", brightBlue:    "#61afef",
  magenta:             "#9b59b6", brightMagenta: "#c678dd",
  cyan:                "#4aabb5", brightCyan:    "#64d5e4",
  white:               "#939aa4", brightWhite:   "#eeeae4",
};

// Covers all common VT/ANSI escape sequences:
//   CSI  \x1b [ <0x20-0x3f>* <0x40-0x7e>   — includes private ?/>/< params
//   OSC  \x1b ] <text> (\x07 | \x1b\)       — BEL or ST terminator
//   Char-set  \x1b [()][…]
//   Other C1  \x1b <any single byte>         — fallback: ESC + one char
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[\x20-\x3f]*[\x40-\x7e]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[\x40-\x7e])/g;

export function stripAnsi(s: string): string {
  return (
    s
      .replace(ANSI_RE, "")  // remove escape sequences
      .replace(/\r/g, "")    // remove lone carriage returns (spinner overwrites)
      // eslint-disable-next-line no-control-regex -- intentional: strip bare ESC bytes from PTY output
      .replace(/\x1b/g, "")  // remove any leftover bare ESC bytes
  );
}

// Read the visible terminal rows (where Claude's input bar lives) and report whether they already
// contain `snippet` — so a re-send doesn't duplicate a prompt that was pasted but never submitted.
// Heuristic: a normalized substring match over the viewport. Best-effort; never throws.
export function terminalShows(term: Terminal | null, snippet: string): boolean {
  if (!term || !snippet.trim()) return false;
  try {
    const buf = term.buffer.active;
    let text = "";
    for (let i = 0; i < term.rows; i++) {
      text += " " + (buf.getLine(buf.baseY + i)?.translateToString(true) ?? "");
    }
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    return norm(text).includes(norm(snippet));
  } catch {
    return false;
  }
}
