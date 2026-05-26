// Pure logic for the console focus queue — the ordered set of panes (active tab)
// that finished a turn (run -> idle) and await a response, cycled through with
// Ctrl+Shift+N or auto-advance on reply. A pane stays queued (even while you view
// it) until you actually send it a response; advancing just moves the cursor.

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
 * The next pane to move to when cycling the queue, relative to the pane you're on.
 * Round-robins through the waiting panes — the current one is NOT removed (a pane
 * leaves only when you respond to it), so cycling can land back on it later.
 *
 * @param queue waiting panes.
 * @param current the pane you're on (focused, or maximized).
 * @returns the next waiting pane, or null when there's nowhere else to go (empty
 *   queue, or the only queued pane is the current one).
 */
export function nextInCycle(queue: number[], current: number): number | null {
  if (queue.length === 0) return null;
  const idx = queue.indexOf(current);
  if (idx === -1) return queue[0];               // current isn't waiting → first waiting pane
  const next = queue[(idx + 1) % queue.length];
  return next === current ? null : next;          // only the current pane is queued → nowhere to go
}

/**
 * Prune the queue to the panes still waiting. A session stays queued only while
 * it's idle and drops out the moment it's no longer idle (it got a response / is
 * working). Run as a sweep whenever statuses change, so a missed transition or a
 * manual focus change can't strand a handled session in the queue.
 *
 * @param queue current waiting queue.
 * @param waiting indices that are currently idle (still waiting).
 * @returns the pruned queue, or the same reference when nothing changed.
 */
export function reconcileQueue(queue: number[], waiting: number[]): number[] {
  const pruned = queue.filter((i) => waiting.includes(i));
  return pruned.length === queue.length ? queue : pruned;
}
