/** Hue of `--accent` (amber). Locked here so every tier stays orange. */
const ACCENT_HUE = 70;

/**
 * Maps a normalized activity value to a heatmap cell colour.
 *
 * Empty days (`v <= 0`) render as the elevated background so "no activity"
 * stays visually distinct from low activity — the same convention GitHub's
 * own calendar uses. Non-zero values ramp through a *single hue* (the accent's
 * orange), with lightness and chroma climbing as activity rises, so the cell
 * colour reads purely as intensity ("more vs. less").
 *
 * We compute the shade directly in OKLCH rather than `color-mix`-ing
 * `var(--accent)` into `var(--bg-elev)`: that background is a cool blue-grey
 * (hue ≈ 250°), and OKLCH mixing interpolates the *hue* channel, dragging the
 * lower tiers toward blue. Locking the hue to {@link ACCENT_HUE} keeps every
 * tier unmistakably orange. `v === 1` reproduces `var(--accent)` exactly
 * (`oklch(0.80 0.14 70)`).
 *
 * @param v - activity normalized to `[0, 1]` (the quartile level / 4). Values
 *            above 1 are clamped; zero and negatives render as the background.
 * @returns a CSS colour string suitable for an SVG `fill` or CSS `background`.
 */
export function heatFill(v: number): string {
  if (v <= 0) return "var(--bg-elev)";
  const t = Math.min(v, 1);
  const lightness = 0.3 + t * 0.5;  // 0.30 → 0.80 (--accent lightness)
  const chroma = 0.05 + t * 0.09;   // 0.05 → 0.14 (--accent chroma)
  return `oklch(${lightness.toFixed(3)} ${chroma.toFixed(3)} ${ACCENT_HUE})`;
}
