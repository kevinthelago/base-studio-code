// Pure targeting logic for console broadcast mode.
//
// Broadcast must only ever reach the consoles in the *actively viewed* tab. Pane
// ids are positional (`t{tabIdx}p{paneIdx}`), so we reconstruct them strictly
// from the active tab's index and its current pane count — never from another
// tab. The focused pane (if any) self-handles its own keystroke through xterm,
// so it is excluded to avoid a double-write; but only when its index is actually
// within this tab, otherwise a stale focus index from a previously-viewed tab
// would wrongly exclude (and silently skip) one of this tab's consoles.

export interface BroadcastPlan {
  /** Pane ids that should receive the keystroke via pty_broadcast. */
  paneIds: string[];
  /**
   * Whether to preventDefault/stopPropagation. True when no pane in this tab owns
   * focus — nothing else will handle the key, so we both broadcast to every pane
   * and stop the event from landing elsewhere.
   */
  suppressDefault: boolean;
}

export function computeBroadcastTargets(
  activeTabIdx: number,
  paneCount: number,
  focusedPaneIdx: number,
): BroadcastPlan {
  // Treat focus as real only when it points at a pane inside this tab.
  const focusedInTab = focusedPaneIdx >= 0 && focusedPaneIdx < paneCount;
  const paneIds: string[] = [];
  for (let i = 0; i < paneCount; i++) {
    if (focusedInTab && i === focusedPaneIdx) continue; // self-handled by xterm
    paneIds.push(`t${activeTabIdx}p${i}`);
  }
  return { paneIds, suppressDefault: !focusedInTab };
}
