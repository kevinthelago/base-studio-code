/**
 * Bucket K timestamp streams into per-day counts over a rolling N-day window, aligned to one label
 * axis — the shape every "activity over the last N days" chart needs.
 *
 * Two properties are the whole point, and both are easy to get wrong by hand:
 *
 * 1. **Empty days are present.** The window is built first and every stream is tallied INTO it, so a
 *    day with no events is a `0`, not a missing entry. Deriving labels from the data instead (the
 *    obvious shortcut) silently compresses quiet days out of the axis, which makes a gap look like a
 *    dip and misstates the trend.
 * 2. **The series are aligned.** Every returned series has exactly `days` entries in the same order as
 *    `labels`, so index `i` means the same day in all of them. A chart layering two series cannot check
 *    this and will happily plot them against each other misaligned.
 *
 * Days are UTC — a rolling window whose bucket boundaries move with the viewer's timezone would make
 * the same data tell two stories. Timestamps are ISO-8601; anything unparseable or outside the window
 * is dropped rather than clamped, because a bad timestamp landing on an edge day is a fabricated event.
 *
 * Harvested from the Fleet page's throughput panel (#3462/#3465).
 */

/** The day axis: display labels and the `YYYY-MM-DD` keys they bucket by, oldest → newest. */
export interface DayWindow {
  labels: string[];
  keys: string[];
}

/** The aligned result: one label axis and one equal-length numeric series per input stream. */
export interface WindowedTally<TName extends string> {
  labels: string[];
  series: Record<TName, number[]>;
}

/**
 * The last `days` UTC days ending at `now` (inclusive), oldest first.
 *
 * `days <= 0` yields an empty window rather than throwing — a caller asking for no window gets no
 * window, and every tally over it is correctly empty.
 */
export function dayWindow(days: number, now: Date): DayWindow {
  const labels: string[] = [];
  const keys: string[] = [];
  for (let i = Math.max(0, Math.floor(days)) - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    labels.push(`${d.getUTCMonth() + 1}/${d.getUTCDate()}`);
    keys.push(d.toISOString().slice(0, 10));
  }
  return { labels, keys };
}

/**
 * Count the timestamps falling on each day of `win`, in window order.
 *
 * Null/undefined/unparseable entries are skipped — these streams come from APIs where "not merged
 * yet" is a null timestamp, so filtering at the call site would be required of every caller.
 */
export function tallyByDay(win: DayWindow, timestamps: ReadonlyArray<string | null | undefined>): number[] {
  const index = new Map(win.keys.map((k, i) => [k, i]));
  const out = new Array<number>(win.keys.length).fill(0);
  for (const ts of timestamps) {
    if (!ts) continue;
    const at = index.get(ts.slice(0, 10));
    if (at !== undefined) out[at] += 1;
  }
  return out;
}

/**
 * Tally several named streams over ONE window, so the result is aligned by construction.
 *
 * Preferred over calling {@link tallyByDay} per stream: sharing the window is what guarantees the
 * series line up, and doing it here removes the caller's opportunity to build two windows a
 * millisecond apart and land the boundary event in different buckets.
 */
export function windowedTally<TName extends string>(
  streams: Record<TName, ReadonlyArray<string | null | undefined>>,
  days: number,
  now: Date,
): WindowedTally<TName> {
  const win = dayWindow(days, now);
  const series = {} as Record<TName, number[]>;
  for (const name of Object.keys(streams) as TName[]) {
    series[name] = tallyByDay(win, streams[name]);
  }
  return { labels: win.labels, series };
}
