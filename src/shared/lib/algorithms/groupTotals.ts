/**
 * Group rows by a key and total a set of numeric fields — per group AND overall — in ONE pass.
 *
 * The back half of every "spend by X" / "usage by Y" rollup: you have a flat list of rows, each with
 * several numbers, and you want both the grand totals and the same totals broken down by some
 * secondary key. Written by hand it is three separate reductions plus a `Map` accumulator, and the
 * usual bug is the group subtotals and the grand total drifting apart because they were summed
 * independently — here they come from the same traversal, so they cannot disagree.
 *
 * The fields to sum are DATA: a record of named numeric accessors. Adding a tracked metric is adding
 * one entry, not editing three reducers. Every field is totalled at both levels; a caller wanting only
 * some grouped just reads the ones it needs.
 *
 * Group order is FIRST-SEEN (insertion order of the backing Map), so the result is deterministic for a
 * given input and a caller that wants a different order sorts the returned groups itself — this does
 * not bake a sort in, because "by first appearance" is the one order that needs no opinion.
 *
 * Harvested from the Fleet page's cost panel (#3462/#3465), where it rolls per-worker token usage up
 * to fleet totals and a by-model breakdown.
 */

/** The totals for one field set — the same keys as the `fields` record, each a summed number. */
export type FieldTotals<F extends string> = Record<F, number>;

/** One group: its key, how many rows fell into it, and the per-field totals for those rows. */
export interface Group<K, F extends string> {
  key: K;
  count: number;
  totals: FieldTotals<F>;
}

/** The rollup: the grand totals over every row, and the per-group breakdown (first-seen order). */
export interface GroupTotals<K, F extends string> {
  totals: FieldTotals<F>;
  count: number;
  groups: Array<Group<K, F>>;
}

/**
 * Total `fields` over `rows`, grouped by `keyOf`.
 *
 * @param rows   the flat input.
 * @param keyOf  the grouping key for a row (the secondary axis — e.g. model name).
 * @param fields named numeric accessors; each is summed at both the group and grand-total level.
 */
export function groupTotals<T, K, F extends string>(
  rows: readonly T[],
  keyOf: (row: T) => K,
  fields: Record<F, (row: T) => number>,
): GroupTotals<K, F> {
  const names = Object.keys(fields) as F[];
  const zero = (): FieldTotals<F> => Object.fromEntries(names.map((n) => [n, 0])) as FieldTotals<F>;

  const grand = zero();
  const groups = new Map<K, Group<K, F>>();

  for (const row of rows) {
    const key = keyOf(row);
    let group = groups.get(key);
    if (!group) {
      group = { key, count: 0, totals: zero() };
      groups.set(key, group);
    }
    group.count += 1;
    for (const name of names) {
      const v = fields[name](row);
      group.totals[name] += v;
      grand[name] += v;
    }
  }

  return { totals: grand, count: rows.length, groups: [...groups.values()] };
}
