// Fleet roster (#734) — persists the launched fleet's session roster to the project hub as
// `fleet.roster.tsv`, so the director's `bsc-fleet` shell helper can enumerate every worker
// (console id / stream / repo / branch / role) and, joined with coord.log, each one's state.
//
// The store builds the rows (it knows the pane keys) but stays Tauri-free; this is the
// component-side writer the launch callers use.

import { fireInvoke } from "@/shared/lib/core/safeInvoke";

/** Write the roster rows to `<hub>/fleet.roster.tsv`. No-op on an empty roster. */
export function publishFleetRoster(projectKey: string, rosterRows: string[]): void {
  if (rosterRows.length === 0) return;
  fireInvoke("write_project_file", {
    projectKey, relpath: "fleet.roster.tsv", contents: rosterRows.join("\n") + "\n",
  }, (e) => console.error("write fleet.roster.tsv failed:", e));
}
