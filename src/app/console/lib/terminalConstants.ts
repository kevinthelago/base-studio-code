// Terminal render/theme constants shared by the xterm PTY mount (TerminalView).
// Pure module-level values — no xterm/PTY/React coupling — extracted so the mount
// module stays focused on the effect wiring.

// Background-pane buffer cap. While a pane is hidden we skip xterm.write
// entirely and accumulate the PTY bytes here; on becoming visible we flush
// them in one go. 256 KB ≈ a few thousand lines of dense output — generous for
// realistic switch-away durations and far above what's likely useful before
// xterm's own scrollback truncates it anyway.
export const PENDING_BYTES_CAP = 256 * 1024;

// Grace before the automatic post-launch redraw nudge (#1221) — long enough for Claude's TUI to
// finish its first paint, so the nudge repaints a fully-drawn (and possibly jumbled) screen rather
// than an empty one. The nudge is idempotent + non-destructive, so an imprecise delay is harmless.
export const AUTO_NUDGE_DELAY_MS = 700;

// Mid-session jumble probe (#1250): at each Claude settle, sample the bottom input-box rows and
// auto-nudge when the box chrome is shattered. Hysteresis — two malformed samples (the settle + one
// quick re-check) before firing — so a lone mid-draw frame doesn't trigger a needless repaint.
// (#1239 reverted the input overlay/clip box, so these now guard Claude's own native input box.)
export const JUMBLE_CHROME_ROWS = 10; // bottom viewport rows that hold Claude's input box + hint lines
export const JUMBLE_STRIKES = 2;
export const JUMBLE_RECHECK_MS = 250;

// Hex equivalents of the oklch design tokens so xterm can use them
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
