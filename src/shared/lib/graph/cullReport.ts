// Cull reporting (#measure-where-the-components-graph-spends-its-commit) — how much of a graph is
// actually mounted, so the effect of viewport culling is a measured number rather than an assumption.
//
// WHY THIS IS NOT OBVIOUS FROM THE CODE. Culling's reach is a function of three things that only meet at
// runtime: the world's shape, the viewport's shape, and the zoom. The components graph wraps at 8 per row,
// so 459 nodes make a world ~1676 wide and ~4800 tall — and with a one-viewport margin the mounted rect is
// WIDER than the entire world at any zoom below ~2.5x. Culling therefore removes nothing horizontally and
// only trims vertically above ~0.5 zoom. None of that is visible from reading the filter; it falls out of
// the arithmetic at the zoom the user happens to be at.
//
// So the honest way to know whether culling is doing anything is to count.

/** One reading of how much of a graph is mounted. */
export interface CullReading {
  shown: number;
  total: number;
  /** The zoom it was taken at — the variable that decides whether culling can help at all. */
  scale: number;
}

/**
 * A one-line summary of a cull reading, or `null` when it is not worth logging.
 *
 * Returns null when NOTHING is culled (`shown === total`). That is the common case at a fit-the-graph
 * zoom, where every node genuinely is visible — reporting it every time would bury the readings that
 * carry information under ones that carry none.
 *
 * Pure so the threshold and the wording are testable without a DOM, a store or a graph.
 */
export function cullSummary(r: CullReading): string | null {
  if (r.total <= 0 || r.shown >= r.total) return null;
  const pct = Math.round((r.shown / r.total) * 100);
  return `[perf] graph cull: ${r.shown}/${r.total} nodes mounted (${pct}%) at ${Math.round(r.scale * 100)}% zoom`;
}

/**
 * Has the reading changed enough to be worth another line?
 *
 * Culling recomputes on every view commit, so an unguarded log would write a line per pan and per zoom
 * step and drown the phase timings this was added to sit beside. A reading is interesting when the
 * mounted COUNT moves materially — `minDelta` nodes — or when it crosses into or out of "nothing culled",
 * which is the transition that actually answers "does culling engage at this zoom".
 */
export function worthReporting(prev: CullReading | null, next: CullReading, minDelta = 20): boolean {
  if (!prev) return true;
  const wasCulling = prev.shown < prev.total;
  const isCulling = next.shown < next.total;
  if (wasCulling !== isCulling) return true;
  return Math.abs(next.shown - prev.shown) >= minDelta;
}
