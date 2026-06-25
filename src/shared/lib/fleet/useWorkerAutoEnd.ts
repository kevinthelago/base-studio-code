// Auto-end a finished fleet worker (#920). When a worker's PTY exits (`pty_exit_{paneId}`),
// evaluate its OWNED-ISSUE STATUS in plan.db and drop the pane into a resting state —
// done / needs-attention / blocked — instead of leaving a dead console in the grid. The PTY
// exit is only the TRIGGER; the verdict comes from the DB (plan_list_issues) with coord.log
// as a tiebreaker (classifyWorkerEnd). The ended state is persisted + recovery-gated, so a
// restart never re-opens a finished worker. Mounted once at the app root.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { ingestCoordLog, emptyCoordState } from "./coordination";
import { classifyWorkerEnd, type OwnedIssue } from "./workerEnd";
import { log } from "../core/log";

/** Evaluate a worker's owned issues on PTY exit and mark the pane ended accordingly. */
async function evaluateExit(paneId: string): Promise<void> {
  const s = useAppStore.getState();
  if (s.endedPanes[paneId]) return; // already ended
  if ((s.paneRoles[paneId] ?? "worker") !== "worker") return; // only auto-end workers
  const stream = s.fleetPaneStreams[paneId];
  if (!stream) return;

  // The owning project key, from the tab that minted this pane id. The old positional
  // `t{tab}p{pane}` parse broke for fleet workers (#1379): #1176 gave them stable
  // `<projectKey>:<streamId>` ids, so look the pane up in its tab's `paneIds` instead.
  const projectKey = s.tabs.find((t) => t.paneIds?.includes(paneId))?.projectKey;
  if (!projectKey) return; // can't query the DB without the project

  const issues = await invoke<OwnedIssue[]>("plan_list_issues", { projectKey, stream: stream.id })
    .catch((e) => { log.error(`auto-end: plan_list_issues failed for ${paneId}: ${e}`); return null; });
  if (!issues) return;

  const coordLines = await invoke<string[]>("read_coord_log", { limit: 5000 }).catch(() => [] as string[]);
  const { state: coord } = ingestCoordLog(coordLines, emptyCoordState());

  const verdict = classifyWorkerEnd(issues.map((i) => ({ ref: i.ref, status: i.status })), coord);
  log.info(`auto-end: ${paneId} (${stream.id}) → ${verdict.state} — ${verdict.summary}`);
  useAppStore.getState().markPaneEnded(paneId, {
    state: verdict.state, streamId: stream.id, summary: verdict.summary, at: Date.now(),
  });
}

export function useWorkerAutoEnd(): void {
  // Re-subscribe whenever the fleet pane set changes (panes come and go across launches).
  const fleetPaneStreams = useAppStore((s) => s.fleetPaneStreams);
  useEffect(() => {
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    for (const paneId of Object.keys(fleetPaneStreams)) {
      if ((useAppStore.getState().paneRoles[paneId] ?? "worker") !== "worker") continue;
      void listen(`pty_exit_${paneId}`, () => { if (!cancelled) void evaluateExit(paneId); })
        .then((off) => { if (cancelled) off(); else unlistens.push(off); });
    }
    return () => { cancelled = true; for (const off of unlistens) off(); };
  }, [fleetPaneStreams]);
}
