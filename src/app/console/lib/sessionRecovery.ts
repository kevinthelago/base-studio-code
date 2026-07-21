// Session recovery (#1266). The backend scans durable, store-independent sources and returns the
// sessions it found (S2, `discover_sessions`); this module reconciles that list against the OPEN
// tabs so only the *unrepresented* sessions — the ones the store has lost or never had — are
// surfaced for the user to act on (S3). Manual scratch shells are flagged reap-only (never
// restored, per #1176).
import { invoke } from "@tauri-apps/api/core";
import { paneIdFor, parsePaneIdentity, isPlanningPaneId, type PaneIdentityKind } from "./paneIdentity";
import { isStudioSessionPaneId } from "@/shared/lib/session/systemSessions";

/** A session reconstructed by the backend from durable sources (#1266 S2 `discover_sessions`). */
export interface DiscoveredSession {
  paneId: string;
  /** Where it was found: any of "ledger", "fleet", "worktree". */
  sources: string[];
  /** The live shell pid, when a running process currently owns this pane. */
  livePid?: number | null;
  /**
   * "running" (a live pid) · "dormant" (on disk, not running) · "planned" (in the plan.db fleet,
   * never launched) · "orphaned" (a live pid whose project was deleted — unrestorable; recovery
   * reaps it, #1279).
   */
  status: "running" | "dormant" | "planned" | "orphaned" | string;
  projectKey?: string | null;
  repo?: string | null;
  /** A cwd to reopen the session at — worktree for a worker, hub for the director. */
  cwd?: string | null;
}

/** A discovered session that is NOT currently open, enriched for the recovery UI (#1266 S3). */
export interface RecoverableSession extends DiscoveredSession {
  /** Parsed from the id grammar (`director` / `worker` / `triage` / `manual` / `positional`). */
  kind: PaneIdentityKind | "unknown";
  /**
   * The session is reap-only — killed, never restored. True for manual scratch shells (#1176) and
   * for `orphaned` shells of a deleted project (no plan to rehydrate, no project to attribute, #1279).
   */
  reapOnly: boolean;
}

/** The minimal tab shape needed to compute open pane ids (a structural subset of the store `Tab`). */
export interface ReconcileTab {
  id?: string;
  kind?: "build" | "triage";
  paneIds?: string[];
  layout?: string;
}

/** Call the backend scan (#1266 S2). Read-only — never mutates anything on disk. */
export async function discoverSessions(): Promise<DiscoveredSession[]> {
  return invoke<DiscoveredSession[]>("discover_sessions");
}

/** Number of grid cells a tab renders — from its minted `paneIds`, else its `cols×rows` layout. */
function cellCount(tab: ReconcileTab): number {
  if (tab.paneIds && tab.paneIds.length > 0) return tab.paneIds.length;
  const m = /^(\d+)\s*[×x]\s*(\d+)$/.exec(tab.layout ?? "");
  return m ? Number(m[1]) * Number(m[2]) : 1;
}

/** Every pane id currently open across all tabs — each cell's resolved identity id. */
export function openPaneIds(tabs: ReconcileTab[]): Set<string> {
  const ids = new Set<string>();
  tabs.forEach((tab, tabIdx) => {
    const cells = cellCount(tab);
    for (let p = 0; p < cells; p++) ids.add(paneIdFor(tab, tabIdx, p));
  });
  return ids;
}

/**
 * Reconcile the backend's discovered sessions against the open tabs (#1266 S3): keep only the
 * sessions NOT currently represented by an open pane, each enriched with its parsed `kind` and a
 * `reapOnly` flag. Reap-only sessions are killed, never restored: manual scratch shells (#1176)
 * and `orphaned` shells of a deleted project (unrestorable — no plan, no project, #1279). The
 * dedicated PLANNER pane (`planning_<key>`) is dropped entirely — a planning session is re-entered
 * from the Projects page, not the recovery banner (#1579). The app-owned STUDIO sessions (designer /
 * librarian / architect, `isStudioSessionPaneId`, #3137) are dropped for the same reason: their ids share
 * the `<key>:<tail>` worker grammar, so without this they'd be surfaced as restorable workers, but they're
 * app-owned singletons re-created when their workspace opens. This is the gap the recovery UI presents
 * for the user to decide on.
 */
export function reconcileSessions(discovered: DiscoveredSession[], tabs: ReconcileTab[]): RecoverableSession[] {
  const open = openPaneIds(tabs);
  return discovered
    .filter((d) => !open.has(d.paneId) && !isPlanningPaneId(d.paneId) && !isStudioSessionPaneId(d.paneId))
    .map((d) => {
      const kind = parsePaneIdentity(d.paneId)?.kind ?? "unknown";
      return { ...d, kind, reapOnly: kind === "manual" || d.status === "orphaned" };
    });
}
