// One shared read of the pane-activity table (#3944).
//
// `logs_pane_activity` returns EVERY pane's latest turn state. `TerminalView` subscribed per pane and
// called it per pane, so a single activity-log write produced N identical full-table reads — 24% of all
// invoke time in a 73-minute sample (2858 calls, 1467ms mean), and at the 16-pane fleet 16 reads per
// write. Each pane then used exactly one row of the result.
//
// This is the third instance of that shape (#3908 warden batch, #3912 fault batch), so it is solved the
// same way: read ONCE per log change, share the rows, let each consumer select its own. The read cost
// stops scaling with pane count.
//
// A module-level store rather than React context: `TerminalView` panes mount and unmount independently
// under the console grid, and a context provider would have to wrap the whole tree just to serve a value
// that is neither rendered nor part of any render path — the rows drive an imperative ref, not JSX. The
// subscription is refcounted, so the underlying `useLogStream` runs only while at least one pane is
// mounted and stops entirely when the console is empty.

import { useEffect, useRef } from "react";
import { logsPaneActivity } from "@/shared/lib/core/logsBridge";
import { useLogStream } from "@/shared/hooks/useLogStream";
import { needsAttention, type PaneActivity } from "./paneActivity";
import { useAppStore } from "@/store";
import { log } from "@/shared/lib/core/log";

type Listener = (rows: PaneActivity[]) => void;

const listeners = new Set<Listener>();
/** The latest table. Kept so a pane mounting mid-stream gets the current state without its own read. */
let latest: PaneActivity[] = [];

/** Publish a fresh table to every subscriber. Exported for tests. */
export function publishPaneActivity(rows: PaneActivity[]): void {
  latest = rows;
  // Each listener is isolated: a pane's callback writes an imperative ref, and one pane throwing must
  // not starve the rest — that would silently stop turn-state tracking for every OTHER pane, which is
  // far worse than the single failure. Logged rather than swallowed so it stays diagnosable.
  for (const fn of [...listeners]) {
    try { fn(rows); } catch (e) { log.error(`pane-activity listener threw: ${String(e)}`); }
  }
}

/** The rows most recently read, for a consumer that needs them synchronously at mount. */
export function currentPaneActivity(): PaneActivity[] {
  return latest;
}

/**
 * Subscribe to the shared table. Returns an unsubscribe. The caller is invoked immediately with the
 * current rows (so a late mount is not blind until the next log write) and again on every change.
 */
export function subscribePaneActivity(fn: Listener): () => void {
  listeners.add(fn);
  if (latest.length > 0) fn(latest);
  return () => { listeners.delete(fn); };
}

/**
 * Drive the shared table off the `activity` log. Mount this ONCE, high in the console tree — every pane
 * then reads through {@link usePaneActivity} instead of issuing its own invoke.
 */
export function usePaneActivityFeed(): void {
  useLogStream("activity", async (isCancelled) => {
    const rows = await logsPaneActivity<PaneActivity>();
    if (isCancelled()) return;
    publishPaneActivity(rows);
    // #4005: project the "stopped waiting on the user" rows into the store, so Glance can raise the
    // `attention` health without importing the console shell (a feature must not import `app/`).
    // Done HERE rather than per pane for the same reason this feed exists at all — one full-table
    // read, one write, instead of N.
    const attn: Record<string, boolean> = {};
    for (const r of rows) if (needsAttention(r)) attn[r.pane] = true;
    useAppStore.getState().setPaneAttention(attn);
  });
}

/**
 * A pane's view of the shared table: `onRows` fires with the full table on every change, and the pane
 * picks its own row. Kept as a callback (not state) because the only consumer writes an imperative ref —
 * turning this into render state would re-render every terminal on every turn boundary, which is the
 * cost this module exists to remove.
 */
export function usePaneActivity(onRows: (rows: PaneActivity[]) => void): void {
  const ref = useRef(onRows);
  useEffect(() => { ref.current = onRows; });
  useEffect(() => subscribePaneActivity((rows) => ref.current(rows)), []);
}
