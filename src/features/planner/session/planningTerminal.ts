// Planner terminal/ANSI helpers, split out of Planning.tsx (#1332): the ANSI-escape stripper and
// a viewport-content probe used to avoid re-sending an already-pasted prompt. (The xterm TERM_THEME
// lives in @/app/console/lib/terminalConstants — the single home shared by every terminal, #3246.)
import type { Terminal } from "@xterm/xterm";

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
