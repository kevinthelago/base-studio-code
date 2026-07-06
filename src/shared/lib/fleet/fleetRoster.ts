// Fleet roster (#734) — persists the launched fleet's session roster to the project hub as
// `fleet.roster.tsv`, so the director's `bsc-fleet` shell helper can enumerate every worker
// (console id / stream / repo / branch / role) and, joined with coord.log, each one's state.
//
// The store builds the rows (it knows the pane keys) but stays Tauri-free; this is the
// component-side writer the launch callers use. It ALSO records the durable session ledger (#2405)
// from the same rows, so recovery reads a fact instead of inferring from disk.

import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { bscWrite } from "@/shared/lib/core/bsc";

/** Write the roster rows to `<hub>/fleet.roster.tsv` AND record each launched agent in the durable
 *  per-project session ledger (#2405). No-op on an empty roster. */
export function publishFleetRoster(projectKey: string, rosterRows: string[]): void {
  if (rosterRows.length === 0) return;
  fireInvoke("write_project_file", {
    projectKey, relpath: "fleet.roster.tsv", contents: rosterRows.join("\n") + "\n",
  }, (e) => console.error("write fleet.roster.tsv failed:", e));
  recordFleetSessions(projectKey, rosterRows);
}

/** Record each launched agent in the durable session ledger (#2405) — the authoritative "these agents
 *  were launched" that survives a clean quit, so recovery can offer to restart the fleet. Best-effort,
 *  fire-and-forget per agent: a failed write never blocks the launch. Fields come straight from the
 *  roster row (`paneId/stream/repo/branch/role`); `cwd` is re-derived from the plan on restart, so it's
 *  left blank here. Exported for the callers/tests; `publishFleetRoster` already invokes it. */
export function recordFleetSessions(projectKey: string, rosterRows: string[]): void {
  for (const row of rosterRows) {
    const [paneId, stream, , , role] = row.split("\t");
    if (!paneId) continue;
    void bscWrite(projectKey, ["plan", "fleet", "session", "set"], {
      paneId,
      // The director row carries "director" in the stream column; a real stream id only for workers.
      streamId: role === "director" ? "" : (stream ?? ""),
      role: role ?? "",
      status: "running",
    }).catch((e) => console.error("record fleet session failed:", e));
  }
}
