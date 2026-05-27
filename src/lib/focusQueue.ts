// Pure logic for the console focus queue — the ordered set of panes (across all
// tabs) that finished a turn (run -> idle) and await a response, cycled through
// with Ctrl+Shift+N or auto-advance on reply. A pane stays queued (even while you
// view it) until you actually send it a response; advancing just moves the cursor,
// switching tabs when the next waiting pane lives on a different tab.

/** A pane's global identity: which tab it's on and its index within that tab. */
export interface QueuedPane {
  tab: number;
  pane: number;
}

const samePane = (a: QueuedPane, b: QueuedPane) => a.tab === b.tab && a.pane === b.pane;

/**
 * Append a pane to the waiting queue, de-duplicated and order-preserving. Returns
 * the same array reference when nothing changes (so the store can skip a needless
 * update).
 *
 * @param queue current waiting queue.
 * @param entry pane that just went idle.
 */
export function enqueue(queue: QueuedPane[], entry: QueuedPane): QueuedPane[] {
  if (entry.pane < 0 || queue.some((q) => samePane(q, entry))) return queue;
  return [...queue, entry];
}

/** Remove a pane (attended, or back to "run"); same reference if not present. */
export function removeFromQueue(queue: QueuedPane[], entry: QueuedPane): QueuedPane[] {
  return queue.some((q) => samePane(q, entry)) ? queue.filter((q) => !samePane(q, entry)) : queue;
}

/**
 * The next pane to move to when cycling the queue, relative to the pane you're on.
 * Round-robins through the waiting panes — the current one is NOT removed (a pane
 * leaves only when you respond to it), so cycling can land back on it later.
 *
 * @param queue waiting panes.
 * @param current the pane you're on (focused, or maximized).
 * @returns the next waiting pane (possibly on another tab), or null when there's
 *   nowhere else to go (empty queue, or the only queued pane is the current one).
 */
export function nextInCycle(queue: QueuedPane[], current: QueuedPane): QueuedPane | null {
  if (queue.length === 0) return null;
  const idx = queue.findIndex((q) => samePane(q, current));
  if (idx === -1) return queue[0];                 // current isn't waiting → first waiting pane
  const next = queue[(idx + 1) % queue.length];
  return samePane(next, current) ? null : next;     // only the current pane is queued → nowhere to go
}

/**
 * Prune the queue to the panes still waiting. We only know live status for the
 * active tab, so this prunes that tab's entries (a session stays queued only while
 * idle, and drops out the moment it's no longer idle) while leaving other tabs'
 * entries untouched. Run as a sweep whenever the active tab's statuses change, so
 * a missed transition or a manual focus change can't strand a handled session.
 *
 * @param queue current waiting queue.
 * @param activeTab the tab whose statuses `waiting` describes.
 * @param waiting pane indices on `activeTab` that are currently idle (still waiting).
 * @returns the pruned queue, or the same reference when nothing changed.
 */
export function reconcileQueue(queue: QueuedPane[], activeTab: number, waiting: number[]): QueuedPane[] {
  const pruned = queue.filter((q) => q.tab !== activeTab || waiting.includes(q.pane));
  return pruned.length === queue.length ? queue : pruned;
}
