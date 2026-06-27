// Canonical pane activity status (#435), shared by the console grid, the per-tab
// fleet rollup, and the tunnel's desktop→mobile status mapping. ONE vocabulary so
// the dot in a pane, the dot on a tab, and the phone mirror can never disagree:
//   • "run"  — a session is actively working (its turn is in flight).
//   • "on"   — a session is attached/connected but at rest (at its prompt).
//   • "idle" — no live session in the cell.
//
// The pure helpers here are the single decision surface for how those per-pane
// states roll up to a tab, which panes count, and when a stale status is dropped —
// extracted from the console so the rules are unit-testable in isolation.
//
// Pane ids are the STABLE identity ids minted by `paneIdFor` (#1176) — `man:<tabId>:p<n>` for a
// manual tab, the minted `paneIds[]` for fleet/triage — NOT the legacy positional `t<idx>p<n>`.
// So the rollup/clear here resolve cells through `paneIdFor` / `paneBelongsToTab` rather than
// reconstructing positional keys, which only ever matched the legacy shape.
import { paneIdFor, paneBelongsToTab, type PaneIdentityTab } from "./paneIdentity";

export type PaneStatus = "run" | "on" | "idle";

/** A tab as the status helpers need it: its layout (cell count) + identity (to mint pane ids). */
export type StatusTab = PaneIdentityTab & { layout: string; state?: PaneStatus };

/** Legacy positional pane key for a (tab, pane) cell — only valid for positional/legacy tabs. */
export function paneKey(tabIdx: number, paneIdx: number): string {
  return `t${tabIdx}p${paneIdx}`;
}

/** Parse a legacy positional pane id back into its (tab, pane) indices, or null when malformed. */
export function parsePaneKey(pid: string): { tabIdx: number; paneIdx: number } | null {
  const m = /^t(\d+)p(\d+)$/.exec(pid);
  return m ? { tabIdx: Number(m[1]), paneIdx: Number(m[2]) } : null;
}

/** Pane-cell count for a "C×R" layout string; falls back to 1 on a malformed layout. */
export function paneCountForLayout(layout: string): number {
  const [c, r] = layout.split("×").map(Number);
  return (c || 1) * (r || 1);
}

/**
 * Roll a tab's per-pane statuses up to a single tab-level status (#435).
 *
 * Only panes that are IN the current grid AND not disabled contribute — so shrinking
 * the layout drops the trimmed cells, and disabling a busy pane immediately stops it
 * counting as "run". Precedence: any live "run" ⇒ "run"; else any "on" ⇒ "on"; else
 * "idle". A pane that paused mid-turn (one cell idle) never pulls a tab out of "run"
 * while another cell is still working — the rollup is over the whole live set.
 *
 * Always computed from the FULL current set, never mutated incrementally, so a stale
 * "run" left by a closed or remounted pane cannot strand the tab in the running state.
 */
export function aggregateTabState(
  tab: StatusTab,
  tabIdx: number,
  statuses: Readonly<Record<string, PaneStatus>>,
  disabledPanes: Readonly<Record<string, boolean>> = {},
): PaneStatus {
  const count = paneCountForLayout(tab.layout);
  let result: PaneStatus = "idle";
  for (let i = 0; i < count; i++) {
    const pid = paneIdFor(tab, tabIdx, i); // the SAME id the pane's PTY + status are keyed by
    if (disabledPanes[pid]) continue; // disabled cell — no live session
    const s = statuses[pid] ?? "idle";
    if (s === "run") return "run"; // any running pane dominates the tab
    if (s === "on") result = "on";
  }
  return result;
}

/**
 * Drop every per-pane status belonging to `tab` (at grid index `tabIdx`) (#435).
 *
 * Used when a tab's panes remount (a runId bump relaunches the sessions) or the tab
 * closes, so a previous session's "run"/"on" never lingers as a stale activity dot on
 * the fresh panes. Membership is by identity (`paneBelongsToTab`), so a manual or minted
 * fleet/triage pane is cleared too — the old positional parse silently kept them. Returns
 * a new map; the input is not mutated.
 */
export function clearTabStatuses(
  statuses: Readonly<Record<string, PaneStatus>>,
  tab: PaneIdentityTab,
  tabIdx: number,
): Record<string, PaneStatus> {
  const next: Record<string, PaneStatus> = {};
  for (const [pid, s] of Object.entries(statuses)) {
    if (!paneBelongsToTab(pid, tab, tabIdx)) next[pid] = s;
  }
  return next;
}
