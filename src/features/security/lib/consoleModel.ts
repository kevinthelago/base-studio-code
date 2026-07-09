// Agents — live console/pane model derived from the real workspace tabs (#1643).
//
// Each workspace tab is a "console"; each live (non-disabled) pane is a row. An
// unassigned pane shows the safe default (Sandboxed) but is only ENFORCED once a
// profile is assigned to it. Pure — split out of SecurityWorkspace so the derivation is
// unit-testable and React-free.

import type { ConsoleSession, ConsolePane } from "./agentProfiles";

/** The minimal tab shape this derivation needs (a subset of the store's `Tab`). */
export interface ConsoleTab {
  name: string;
  /** Grid layout like `"2×2"` — cols × rows. */
  layout: string;
}

export interface DeriveConsolesArgs {
  tabs: readonly ConsoleTab[];
  /** Per-tab, per-pane display name (`paneNames[tabIdx][paneIdx]`). */
  paneNames: Record<number, Record<number, string>>;
  /** Panes that were unmounted / killed, keyed `t{tab}p{pane}`. */
  disabledPanes: Record<string, boolean>;
  /** Per-pane assigned profile id, keyed `t{tab}p{pane}`. */
  paneProfiles: Record<string, string>;
  /** The active repo name (falls back to `—` when none). */
  activeRepoName?: string | null;
}

/**
 * Derive the console/pane model from the workspace tabs. One console per tab; one
 * pane row per live grid cell (disabled panes are skipped). An unassigned pane
 * defaults to `pf_sandbox`.
 */
export function deriveConsoles({
  tabs, paneNames, disabledPanes, paneProfiles, activeRepoName,
}: DeriveConsolesArgs): ConsoleSession[] {
  return tabs.map((t, ti) => {
    const [cols, rows] = t.layout.split("×").map(Number);
    const count = (cols || 1) * (rows || 1);
    const panes: ConsolePane[] = [];
    for (let i = 0; i < count; i++) {
      const pid = `t${ti}p${i}`;
      if (disabledPanes[pid]) continue;
      panes.push({
        id: pid,
        agent: paneNames[ti]?.[i] ?? `pane ${i + 1}`,
        status: "idle",
        profileId: paneProfiles[pid] ?? "pf_sandbox",
      });
    }
    return { id: `t${ti}`, name: t.name, repo: activeRepoName ?? "—", status: "running", projectAllow: [], panes };
  });
}
