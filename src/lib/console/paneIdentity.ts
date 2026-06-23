// Pane identity (#1176). Pane state, the PTY, and crash recovery must key off a STABLE identity
// id, not the positional `t{tabIdx}p{paneIdx}` — positional keys get reused when a tab is closed
// and a new one lands on the index, so the new pane inherits persisted state (paneWasClaude, cwd,
// restoreRequested) and resumes a previous session.
//
// Identity is minted where a pane is created:
//   - MANUAL console ("+" button): an ephemeral id unique to the tab — `man:<tabId>:p<idx>`. The
//     tab already carries a stable uuid `id`, so a fresh manual tab can never collide into an old
//     one's state, and (because the id isn't a `project:…` identity) it is excluded from recovery.
//   - FLEET / TRIAGE panes: a meaningful id minted by project planning / triage launch
//     (`<projectKey>:<streamId>`, `<projectKey>:director`, `<projectKey>:<repo>:triage`), recorded
//     on the tab's `paneIds[]`. Recovery reconnects only the exact identity it belongs to.
//
// Stage 1 wires the MANUAL path; fleet/triage tabs (those with `kind`) keep the positional id until
// Stage 2 mints their `paneIds`.

export interface PaneIdentityTab {
  id?: string;
  /** Fleet ("build") / "triage" tabs are app-created; absence ⇒ a manually-created console. */
  kind?: "build" | "triage";
  /** Per-cell identity ids minted at fleet/triage launch (Stage 2). */
  paneIds?: string[];
}

/** The legacy positional id — still used for fleet/triage tabs until Stage 2. */
export function positionalPaneId(tabIdx: number, paneIdx: number): string {
  return `t${tabIdx}p${paneIdx}`;
}

/** A manual console pane's ephemeral, per-tab id. */
export function manualPaneId(tabId: string, paneIdx: number): string {
  return `man:${tabId}:p${paneIdx}`;
}

/** Fleet worker / director identity ids. */
export function fleetPaneId(projectKey: string, streamId: string): string {
  return `${projectKey}:${streamId}`;
}
export function directorPaneId(projectKey: string): string {
  return `${projectKey}:director`;
}

/** A per-repo triage pane's identity id. */
export function triagePaneId(projectKey: string, repo: string): string {
  return `${projectKey}:${repo}:triage`;
}

/** Whether an id is a manual console pane — manual panes are never auto-recovered (#1176). */
export function isManualPaneId(id: string): boolean {
  return id.startsWith("man:");
}

/**
 * Resolve a pane's identity id from its tab + grid position. A minted `paneIds[idx]` (fleet/triage,
 * Stage 2) wins; otherwise a fleet/triage tab keeps the positional id (Stage 1), a manual tab with a
 * stable `id` gets a `man:` id, and an id-less legacy tab falls back to positional.
 */
export function paneIdFor(tab: PaneIdentityTab | undefined, tabIdx: number, paneIdx: number): string {
  const minted = tab?.paneIds?.[paneIdx];
  if (minted) return minted;
  if (tab?.kind) return positionalPaneId(tabIdx, paneIdx);
  if (tab?.id) return manualPaneId(tab.id, paneIdx);
  return positionalPaneId(tabIdx, paneIdx);
}
