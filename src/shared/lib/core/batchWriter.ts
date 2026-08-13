// Batched write-behind (#the-scan-cache-stops-spawning-a-process-per-batch) — collapse many small writes
// into few expensive ones.
//
// WHY THIS IS ITS OWN THING. The Design Studio's scan cache hung its durable write on the same 150ms timer
// as its store write. That was right for the store (an in-memory setState) and wrong for the cache (a
// PROCESS SPAWN): a full sweep fired ~400 of them — 157 SECONDS of process churn, measured — for data that
// only had to be correct by the time the sweep ended.
//
// The rule is small but it has three parts that are each easy to get wrong on their own, which is why it
// lives here rather than inline in a hook: coalesce by KEY (a component scanned twice in one window is one
// write, not two), fire on a SLOW clock, and never lose what the clock has not reached when the caller
// tears down. Written once, testable without React, and reusable for the next expensive sink — the app has
// several other places that spawn a process per event.
//
// It is write-BEHIND, so the caller accepts that a crash loses at most one window. That is only safe where
// the data can be recomputed; the scan cache qualifies because a lost entry is simply re-scanned.

/** A batch writer over keyed entries. Create one per sink, call {@link BatchWriter.queue} freely, and
 *  {@link BatchWriter.flush} on teardown. */
export interface BatchWriter<T> {
  /** Merge entries into the pending set and arm the timer if it is not already armed. */
  queue: (entries: Record<string, T>) => void;
  /** Write whatever is pending NOW and disarm — for a caller tearing down. No-op when nothing is pending. */
  flush: () => void;
  /** How many entries are waiting (for tests + diagnostics). */
  pending: () => number;
}

/**
 * Create a batch writer that calls `write` at most once per `ms`, carrying every entry queued in that
 * window.
 *
 * Entries are keyed, and a later value for the same key REPLACES the earlier one — a component scanned
 * twice inside one window should cost one write carrying its latest result, not two carrying a stale one
 * and then a fresh one.
 *
 * The timer is armed on the FIRST queue after a write, not reset on each one: a debounce that restarts on
 * every entry would never fire during a steady stream of results, which is exactly the shape of a sweep.
 */
export function makeBatchWriter<T>(write: (batch: Record<string, T>) => void, ms: number): BatchWriter<T> {
  let pending: Record<string, T> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const keys = Object.keys(pending);
    if (keys.length === 0) return;
    const batch = pending;
    pending = {};
    write(batch);
  };

  return {
    queue(entries) {
      Object.assign(pending, entries);
      // `??=` not a reset: re-arming on every entry is a debounce, and a debounce never fires while
      // results keep arriving — which is the whole duration of a sweep.
      timer ??= setTimeout(flush, ms);
    },
    flush,
    pending: () => Object.keys(pending).length,
  };
}
