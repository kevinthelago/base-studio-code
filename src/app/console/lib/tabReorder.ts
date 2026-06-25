// tabReorder -- pure helpers for moving a tab within the strip (#461).
//
// Tabs are identified by ARRAY INDEX, and a lot of state keys off that index
// (paneNames by tabIdx; paneCwds/paneStatus/disabledPanes/paneMcpServers/paneHooks/
// paneAllowedCommands by "t{tab}p{pane}"; focusQueue entries by {tab,pane}).
// Reordering the tabs array therefore has to remap every one of those keys or
// state bleeds onto the wrong tab. These functions are pure (no React/Tauri) so
// the remap is unit-testable; the store's `moveTab` action composes them.

import type { QueuedPane } from "./focusQueue";

/** Move the element at `from` to `to` in a new array (no mutation). Out-of-range
 *  or no-op moves return a shallow copy unchanged. */
export function moveInArray<T>(arr: T[], from: number, to: number): T[] {
  const out = arr.slice();
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [m] = out.splice(from, 1);
  out.splice(to, 0, m);
  return out;
}

/** Map OLD tab index → NEW tab index after moving a tab from `from` to `to`
 *  (`result[oldIdx] = newIdx`). Identity for invalid/no-op moves. */
export function tabIndexMap(n: number, from: number, to: number): number[] {
  const order = moveInArray(Array.from({ length: n }, (_, i) => i), from, to); // order[newIdx] = oldIdx
  const newIndexOf = new Array<number>(n);
  order.forEach((oldIdx, newIdx) => { newIndexOf[oldIdx] = newIdx; });
  return newIndexOf;
}

/** Rekey a map keyed by tab index (number) through the index map. */
export function rekeyByTab<T>(map: Record<number, T>, newIndexOf: number[]): Record<number, T> {
  const out: Record<number, T> = {};
  for (const [k, v] of Object.entries(map)) {
    const oldTab = Number(k);
    out[newIndexOf[oldTab] ?? oldTab] = v;
  }
  return out;
}

/** Rekey a map keyed by "t{tab}p{pane}" through the index map. Keys that don't
 *  match that shape pass through untouched (so repo-/other-keyed maps are safe). */
export function rekeyByPaneId<T>(map: Record<string, T>, newIndexOf: number[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(map)) {
    const m = k.match(/^t(\d+)p(\d+)$/);
    if (!m) { out[k] = v; continue; }
    const newTab = newIndexOf[Number(m[1])] ?? Number(m[1]);
    out[`t${newTab}p${m[2]}`] = v;
  }
  return out;
}

/** Remap the tab index on each focus-queue entry. */
export function remapFocusQueue(queue: QueuedPane[], newIndexOf: number[]): QueuedPane[] {
  return queue.map((q) => ({ ...q, tab: newIndexOf[q.tab] ?? q.tab }));
}
