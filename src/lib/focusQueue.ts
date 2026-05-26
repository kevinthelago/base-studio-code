// Pure logic for the console focus queue — the ordered set of panes (active tab)
// that finished a turn (run -> idle) and await attention, stepped through with
// Ctrl+Shift+N. FIFO by completion: oldest waiting agent first.

/**
 * Append a pane index to the waiting queue, de-duplicated and order-preserving.
 * Returns the same array reference when nothing changes (so the store can skip a
 * needless update).
 *
 * @param queue current waiting queue.
 * @param idx pane index that just went idle.
 * @param skip a pane to never enqueue — e.g. the focused pane you're watching.
 */
export function enqueue(queue: number[], idx: number, skip = -1): number[] {
  if (idx < 0 || idx === skip || queue.includes(idx)) return queue;
  return [...queue, idx];
}

/** Remove a pane (attended, or back to "run"); same reference if not present. */
export function removeFromQueue(queue: number[], idx: number): number[] {
  return queue.includes(idx) ? queue.filter((q) => q !== idx) : queue;
}

/**
 * Take the next waiting pane (front of the FIFO queue).
 * @returns the next pane index and the remaining queue, or `next: null` when empty.
 */
export function dequeueNext(queue: number[]): { next: number | null; rest: number[] } {
  if (queue.length === 0) return { next: null, rest: queue };
  return { next: queue[0], rest: queue.slice(1) };
}
