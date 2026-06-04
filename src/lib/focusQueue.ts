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

// ── Role-aware focus targeting (#392) ─────────────────────────────────────────
//
// Which panes the autofocus queue pulls your attention to. With a director/worker
// fleet, you usually want only the DIRECTOR to surface — workers run dark and
// escalate via bsc-ask (which flips their pane to awaiting-input through the
// coordinator), so genuine worker questions still reach you. A plain console
// (no role) always queues, except under "none".

export type FocusTarget =
  | "director"   // default: the integrator + plain consoles; workers run dark
  | "workers"    // workers + plain consoles (debug worker behavior)
  | "fleet"      // every fleet role (director + workers) + consoles
  | "everything" // every idle pane, whatever its role
  | "none";      // nothing auto-queues (fully manual)

/** The presets, in display order — for a picker control. */
export const FOCUS_TARGETS: FocusTarget[] = ["director", "workers", "fleet", "everything", "none"];

/** Default focus target — surface the director; let workers run dark. */
export const DEFAULT_FOCUS_TARGET: FocusTarget = "director";

/** Human label for a focus target. */
export function focusTargetLabel(t: FocusTarget): string {
  switch (t) {
    case "director": return "Director";
    case "workers": return "Workers";
    case "fleet": return "Director + workers";
    case "everything": return "Everything";
    case "none": return "None";
  }
}

/**
 * Whether a pane that just went idle should join the focus queue, given the active
 * target. A role-less pane (a plain console — `role` undefined/empty) always queues
 * except under "none", so single-console behavior is unchanged for every target but
 * "none". A fleet pane queues only when its role matches the target.
 *
 * @param role the pane's session role (`paneRoles[pid]`), or undefined for a plain console.
 * @param target the active focus target.
 */
export function shouldFocus(role: string | undefined, target: FocusTarget): boolean {
  if (target === "none") return false;
  if (!role) return true;                       // plain console — always queue (except "none")
  switch (target) {
    case "everything": return true;
    case "director":   return role === "director";
    case "workers":    return role === "worker";
    case "fleet":      return role === "director" || role === "worker";
  }
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
 * Prune the queue to the panes still waiting, across every tab whose live status
 * we have. After #187 every tab's panes stay mounted, so the caller can supply a
 * per-tab waiting set for every tab — a queued entry stays iff its pane appears
 * in its tab's set. Tabs absent from the map (no live data — e.g. an empty
 * workspace mid-transition) leave their entries alone, since we don't want a
 * temporarily-missing tab to silently drop queued panes.
 *
 * @param queue current waiting queue.
 * @param waitingByTab live waiting indices per tab (idle panes that should stay queued).
 * @returns the pruned queue, or the same reference when nothing changed.
 */
export function reconcileQueue(
  queue: QueuedPane[],
  waitingByTab: ReadonlyMap<number, ReadonlySet<number>>,
): QueuedPane[] {
  const pruned = queue.filter((q) => {
    const waiting = waitingByTab.get(q.tab);
    return waiting === undefined || waiting.has(q.pane);
  });
  return pruned.length === queue.length ? queue : pruned;
}
