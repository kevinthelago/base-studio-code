// Shared numeric helpers (#2421) — feature-agnostic, pure. The one home for the clamp
// that was written three ways (useDragResize's clampSize, useGraphViewport's local const,
// and many inline Math.min/Math.max chains).

/**
 * Clamp `value` into the inclusive `[min, max]` range.
 *
 * Equivalent to `Math.max(min, Math.min(max, value))` — so like every prior inline chain,
 * a caller passing an inverted range (min > max) gets `min` back.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
