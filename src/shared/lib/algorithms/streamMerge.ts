/**
 * Merge K differently-shaped event streams into ONE recent-first feed, with a distinguished class
 * pinned ABOVE the time sort, plus a count per kind.
 *
 * The shape behind every "activity" / "what needs attention" panel that draws from several sources at
 * once (errors, warnings, denials, …). Three things it gets right that the hand-written version gets
 * wrong under maintenance:
 *
 * 1. **Heterogeneous in, homogeneous out.** Each stream has its OWN shape and its own projection to a
 *    common item; the merge never sees the source shapes. Adding a stream is adding a `(source,
 *    project)` pair, not editing a growing sort.
 * 2. **A pinned class outranks recency.** Some items are LIVE ("this is happening now") and must sit
 *    at the top regardless of timestamp — a currently-stalled worker above yesterday's resolved error.
 *    Modelled as a real flag (`pinned`), not the sentinel `sortKey: Infinity` the original used, which
 *    silently breaks the moment a second pinned item needs ordering among its peers.
 * 3. **Counts come from the merged feed, not recomputed.** One pass, so the badge can never disagree
 *    with the list it summarises.
 *
 * Sort is STABLE within a rank: pinned-vs-unpinned first, then `sortKey` descending, ties keeping
 * input order — so equal-timestamp items don't reshuffle between renders. Harvested from the Fleet
 * page's health panel (#3462/#3465).
 */

/** One normalized feed entry. `kind` is the caller's classification (counted); `pinned` lifts it above
 *  the time sort; `sortKey` orders the rest (a timestamp, descending = newest first). */
export interface FeedItem<TKind extends string> {
  kind: TKind;
  pinned: boolean;
  sortKey: number;
}

/** One input stream: its raw items plus how to project each to a {@link FeedItem}. Generic over the
 *  source shape AND the extra payload `P` the projection carries through (label, detail, …). */
export interface FeedStream<TKind extends string, P> {
  items: readonly unknown[];
  project: (raw: unknown) => (FeedItem<TKind> & P) | null;
}

/** Build one typed stream — a small helper so the source type is inferred rather than cast at the
 *  call site (each stream keeps its own element type until `project` normalizes it). */
export function feedStream<TRaw, TKind extends string, P>(
  items: readonly TRaw[],
  project: (raw: TRaw) => (FeedItem<TKind> & P) | null,
): FeedStream<TKind, P> {
  return { items, project: (raw) => project(raw as TRaw) };
}

/** The merged result: the ordered feed and a count per kind (every kind in `kinds` present, zeros
 *  included, so a caller can render a fixed set of badges without guarding for missing keys). */
export interface MergedFeed<TKind extends string, P> {
  items: Array<FeedItem<TKind> & P>;
  counts: Record<TKind, number>;
  total: number;
  hasItems: boolean;
}

/**
 * Merge the streams into one ordered feed with per-kind counts.
 *
 * `kinds` is the closed set of classifications, passed IN so `counts` has a zero for every one — the
 * feed alone can only count kinds that occurred, and a badge row that appears and disappears with the
 * data is worse than one that reads `0`.
 *
 * A stream's `project` returning null drops that raw item (a "done" verdict is not an error), so
 * filtering is part of the projection rather than a separate pass the caller has to remember.
 */
export function mergeFeeds<TKind extends string, P>(
  streams: ReadonlyArray<FeedStream<TKind, P>>,
  kinds: readonly TKind[],
): MergedFeed<TKind, P> {
  const items: Array<FeedItem<TKind> & P> = [];
  for (const stream of streams) {
    for (const raw of stream.items) {
      const item = stream.project(raw);
      if (item) items.push(item);
    }
  }
  // Stable: pinned first, then newest first, ties keeping insertion order (Array.sort is stable).
  items.sort((a, b) => (a.pinned === b.pinned ? b.sortKey - a.sortKey : a.pinned ? -1 : 1));

  const counts = Object.fromEntries(kinds.map((k) => [k, 0])) as Record<TKind, number>;
  for (const it of items) counts[it.kind] += 1;

  return { items, counts, total: items.length, hasItems: items.length > 0 };
}
