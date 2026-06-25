// Jumble detection for the Claude CLI's TUI (#1250). Pure so the verdict is unit-testable from
// plain row strings — no xterm in jsdom. The caller (TerminalView) samples the bottom input-box
// rows of a *Claude CLI* session at each settle, runs this, and nudges (requestPaneRedraw, #1221)
// when the chrome is shattered. ONLY for the Claude CLI — an API / bsc-agent session renders its
// own UI, not this box chrome, so the caller must gate on the provider before sampling.

export type JumbleVerdict = "healthy" | "malformed" | "unknown";

// Horizontal box-drawing runs (incl. heavy / double / dashed) make up the input box's top + bottom
// borders — the structure we check for integrity.
const HORIZ = "─━═┄┅┈┉╌╍";
// Any box-drawing character — tells us TUI chrome is present at all (vs. plain output).
const BOX = /[─━═┄┅┈┉╌╍╭╮╰╯┌┐└┘╔╗╚╝│┃║┆┇┊┋]/;

/** Longest contiguous run of horizontal box-drawing characters in a row. */
function longestHorizRun(row: string): number {
  let best = 0;
  let cur = 0;
  for (const ch of row) {
    if (HORIZ.includes(ch)) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

/**
 * Classify the sampled chrome rows of a Claude CLI TUI (the bottom input-box region) as a `healthy`
 * render, a `malformed` (jumbled) one, or `unknown` when there's no chrome to judge.
 *
 * Heuristic: the Claude input box draws a full-width horizontal border (top + bottom). A clean
 * render has at least one long, unbroken run of horizontal box characters; a jumbled redraw
 * overwrites/shifts those cells, shattering the run. So:
 *   - no box-drawing characters at all   → `unknown` (plain output; can't tell — don't nudge)
 *   - box chars present + a long border   → `healthy`
 *   - box chars present but no long border → `malformed`
 *
 * Conservative by design: it only flags `malformed` when chrome IS present but broken, never on
 * ordinary text. The caller applies hysteresis (re-check before firing) to ride out a lone
 * mid-draw frame.
 */
export function probeJumble(rows: string[], cols: number): JumbleVerdict {
  if (cols <= 0 || rows.length === 0) return "unknown";
  if (!rows.some((r) => BOX.test(r))) return "unknown";
  // A healthy border spans most of the width; require half the columns (min 8 for a narrow pane).
  const healthyRun = Math.max(8, Math.floor(cols * 0.5));
  const longest = rows.reduce((m, r) => Math.max(m, longestHorizRun(r)), 0);
  return longest >= healthyRun ? "healthy" : "malformed";
}
