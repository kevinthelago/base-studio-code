/**
 * Quartile (rank-based) intensity scaling for the activity heatmap.
 *
 * GitHub's contribution calendar colours each day by which quartile of the
 * distribution of *non-zero* days its count falls into — not by `count / max`.
 * This is what makes it robust to outliers: a single 400-commit day can't wash
 * out the scale, because intensity is rank-based, not magnitude-based. The
 * busier days spread across levels 1–4 regardless of how extreme the peak is.
 *
 * The four non-zero levels are returned as evenly-spaced positions on `[0, 1]`
 * (0.25 / 0.5 / 0.75 / 1) so they sample the cool→warm gradient that {@link
 * heatFill} renders — the calendar keeps its two-colour ramp while bucketing
 * intensity GitHub-style. Empty days return 0 and render as background.
 *
 * Trade-off (inherent to quartile bucketing): absolute magnitude is lost — a
 * 10-commit day and a 400-commit day can share the top bucket. Exact counts are
 * surfaced in the cell tooltip instead.
 *
 * @param counts - raw contribution count per day (any length; order preserved).
 * @returns one normalized intensity per input day, each in {0, .25, .5, .75, 1}.
 */
export function quartileScale(counts: number[]): number[] {
  const nonZero = counts.filter(c => c > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return counts.map(() => 0);

  const q1 = percentile(nonZero, 0.25);
  const q2 = percentile(nonZero, 0.5);
  const q3 = percentile(nonZero, 0.75);

  return counts.map(c => {
    if (c <= 0) return 0;
    // Level = 1 + (number of quartile thresholds the count exceeds), so the
    // busiest days (above the 75th percentile) reach level 4 / full warmth.
    let level = 1;
    if (c > q1) level++;
    if (c > q2) level++;
    if (c > q3) level++;
    return level / 4;
  });
}

/**
 * Linear-interpolation percentile (type-7, as used by NumPy/Excel) over an
 * ascending pre-sorted array.
 *
 * @param sorted - non-empty array sorted ascending.
 * @param p - quantile in `[0, 1]`.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}
