/**
 * Sort items by a DECLARED priority ranking of a category — an order that is deliberately NOT the
 * category's natural or alphabetical one.
 *
 * The everyday case is an "attention queue": items fall into a few states and the useful order is by
 * urgency, which no property of the state gives you. Written by hand it becomes a bare comparator with
 * the ranking buried in a chain of ternaries (`s === "blocked" ? 0 : s === "running" ? 1 : …`) — the
 * priority is real domain knowledge but exists only as magic numbers inside a sort, where it cannot be
 * read as a list, reused, or reordered without recounting.
 *
 * Here the ranking is DATA: an array, first = highest priority. That array is the decision; the sort
 * is mechanical. A category not in the ranking sorts AFTER every ranked one (rather than silently
 * becoming rank 0 and jumping the queue) — an unranked value is "no stated priority", not "top
 * priority". The sort is STABLE, so items of equal rank keep their input order.
 *
 * Harvested from the Fleet page's merge queue (#3462/#3465).
 */

/**
 * A stable copy of `items` ordered by the priority of each item's category.
 *
 * `ranking[0]` is highest priority. An item whose category is not in `ranking` sorts after every
 * ranked item, in input order among its unranked peers.
 */
export function orderByRank<T, R>(
  items: readonly T[],
  categoryOf: (item: T) => R,
  ranking: readonly R[],
): T[] {
  const rankOf = new Map<R, number>(ranking.map((r, i) => [r, i]));
  // Unranked → after everything ranked. `ranking.length` sits past the last real rank.
  const rank = (item: T) => rankOf.get(categoryOf(item)) ?? ranking.length;
  // Decorate-sort-undecorate keeps it stable AND calls `categoryOf` once per item rather than O(n log n)
  // times — the naive `.sort((a,b) => rank(a) - rank(b))` re-derives the category on every comparison.
  return items
    .map((item, i) => ({ item, i, r: rank(item) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((d) => d.item);
}
