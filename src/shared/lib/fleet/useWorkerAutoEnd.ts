// Auto-end a finished fleet worker (#920 / #1379). Two triggers drop a worker pane into a resting
// state (done / needs-attention / blocked) instead of leaving a dead console in the grid:
//   - `pty_exit_{paneId}` — the shell exited (legacy; rarely fires for the long-lived REPL).
//   - `bsc-done` (#1379) — a finished worker self-reports via `done.log`; we poll `read_done_panes`
//     and reap, additionally `pty_kill`-ing the still-live session.
// Either way the TRIGGER is only the prompt to evaluate; the verdict comes from plan.db
// (`plan_list_issues`) with coord.log as a tiebreaker (`classifyWorkerEnd`) — NOT the worker's
// say-so. The ended state is persisted + recovery-gated, so a restart never re-opens a finished
// worker. Mounted once at the app root.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { ingestCoordLog, emptyCoordState } from "./coordination";
import { classifyWorkerEnd, type OwnedIssue } from "./workerEnd";
import { log } from "../core/log";

/**
 * Evaluate a worker's owned issues and mark the pane ended accordingly. `opts.kill` also kills the
 * PTY — used by the `bsc-done` path, where the worker is still live (the `pty_exit` path leaves it
 * false, since the shell already exited).
 */
async function evaluateExit(paneId: string, opts: { kill?: boolean } = {}): Promise<void> {
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
  // bsc-done (#1379): the worker is still live and asked to close, so actually kill its PTY.
  if (opts.kill) {
    await invoke("pty_kill", { paneId }).catch((e) => log.error(`auto-end: pty_kill failed for ${paneId}: ${e}`));
  }
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

  // bsc-done self-close (#1379): poll the workers that self-reported done and reap each —
  // classify from plan.db (markPaneEnded) AND pty_kill the still-live shell. The endedPanes guard
  // in evaluateExit makes this idempotent across polls (a lingering done.log line won't re-kill).
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const done = await invoke<string[]>("read_done_panes").catch(() => [] as string[]);
      if (cancelled || !Array.isArray(done)) return;
      const s = useAppStore.getState();
      for (const paneId of done) {
        if (s.endedPanes[paneId] || !s.fleetPaneStreams[paneId]) continue;
        await evaluateExit(paneId, { kill: true });
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
}
