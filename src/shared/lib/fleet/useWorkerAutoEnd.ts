// Auto-end a finished fleet worker (#920 / #1379). Two triggers drop a worker pane into a resting
// state (done / needs-attention / blocked) instead of leaving a dead console in the grid:
//   - `pty_exit_{paneId}` — the shell exited (legacy; rarely fires for the long-lived REPL).
//   - `bsc-done` (#1379) — a finished worker self-reports via `done.log`; we poll `read_done_panes`
//     and reap, additionally `pty_kill`-ing the still-live session.
// Either way the TRIGGER is only the prompt to evaluate; the verdict comes from plan.db
// (`plan_list_issues`) with coord.log as a tiebreaker (`classifyWorkerEnd`) — NOT the worker's
// say-so. The ended state is persisted + recovery-gated, so a restart never re-opens a finished
// worker. Mounted once at the app root.

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { ingestCoordLog, emptyCoordState } from "./coordination";
import { classifyWorkerEnd, type OwnedIssue } from "./workerEnd";
import { decideWorkerAutoEnd, DEFAULT_AUTO_END_THRESHOLDS } from "./workerAutoEnd";
import { log } from "../core/log";

/** One pane's latest turn-boundary state, as `read_pane_activity` (tokens.rs `PaneActivity`)
 *  returns it — typed locally so this shared module doesn't import the app layer. */
interface ActivityRow { pane: string; state: string; at: number }

/** The close-nudge injected into an idle, question-free, work-complete worker (#1379). It asks the
 *  worker to self-assess and `bsc-done` if truly finished — never forces it; `bsc-defer` only fires
 *  on a Stop, so this prompt doesn't fight it. One line so the trailing Enter submits it. */
const CLOSE_NUDGE =
  "Your owned issues all read complete in the plan and this session has gone idle. If your work is " +
  "genuinely done — everything integrated on develop with the gate green — run `bsc-done` to close " +
  "this console. If anything remains, keep going instead.";

/** How idle-poll ticks: every 15s. The close-nudge threshold is 60s, so this is responsive enough. */
const IDLE_POLL_MS = 15_000;

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
  // Director close-open-issues nudge (#1379): a develop self-merge doesn't fire `Closes #N` (that's
  // default-branch only), so a done stream's issues linger OPEN on the board. Nudge the project's
  // director (if one is live) to close them — the app never closes GitHub issues itself.
  if (verdict.state === "done") {
    const directorPane = `${projectKey}:director`;
    if (useAppStore.getState().paneRoles[directorPane] === "director") {
      const refs = issues.map((i) => i.ref).join(", ");
      const msg = `Stream ${stream.id} finished — its issues (${refs}) are complete in the plan. Close any still open on GitHub with \`gh issue close <ref>\`; a develop push doesn't auto-close them.`;
      await invoke("pty_write", { paneId: directorPane, data: `${msg}\r` }).catch(() => {});
    }
  }
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

  // Idle close-nudge (#1379 stage 3): for each at-rest worker, decide via the pure core whether to
  // nudge it to self-close. A worker that's question-free, idle past the short window, and whose
  // owned issues all read complete in plan.db gets ONE "wrap up / bsc-done" prompt; the nudge
  // re-arms when its turn reopens. A worker paused for the user (coord.waiting) is left alone, and
  // an outstanding director question routes to the resurface path (stage 4), never a close.
  const nudgedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const activity = await invoke<ActivityRow[]>("read_pane_activity").catch(() => [] as ActivityRow[]);
      const coordLines = await invoke<string[]>("read_coord_log", { limit: 5000 }).catch(() => [] as string[]);
      if (cancelled || !Array.isArray(activity)) return;
      const { state: coord } = ingestCoordLog(Array.isArray(coordLines) ? coordLines : [], emptyCoordState());
      const s = useAppStore.getState();
      const now = Date.now();
      for (const paneId of Object.keys(s.fleetPaneStreams)) {
        if (s.endedPanes[paneId] || (s.paneRoles[paneId] ?? "worker") !== "worker") continue;
        const act = activity.find((a) => a.pane === paneId);
        if (act?.state === "run") { nudgedRef.current.delete(paneId); continue; } // working → re-arm
        if (coord.waiting.some((w) => w.session === paneId)) continue;             // paused for the user → leave it
        const stream = s.fleetPaneStreams[paneId];
        const projectKey = s.tabs.find((t) => t.paneIds?.includes(paneId))?.projectKey;
        if (!projectKey || !stream) continue;
        const issues = await invoke<OwnedIssue[]>("plan_list_issues", { projectKey, stream: stream.id }).catch(() => null);
        if (cancelled || !issues) continue;
        const verdict = classifyWorkerEnd(issues.map((i) => ({ ref: i.ref, status: i.status })), coord);
        const action = decideWorkerAutoEnd({
          turnOpen: act?.state === "run",
          idleMs: act?.state === "idle" ? now - act.at : 0,
          hasOutstandingQuestion: coord.asking.some((a) => a.session === paneId),
          verdict,
        }, DEFAULT_AUTO_END_THRESHOLDS);
        if (action === "close-nudge" && !nudgedRef.current.has(paneId)) {
          nudgedRef.current.add(paneId); // once per idle period; cleared when the turn reopens
          log.info(`auto-end: nudging ${paneId} (${stream.id}) to self-close — idle + work complete`);
          await invoke("pty_write", { paneId, data: `${CLOSE_NUDGE}\r` }).catch(() => {});
        }
        // "resurface-question" is wired in stage 4.
      }
    };
    void tick();
    const id = setInterval(() => void tick(), IDLE_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
}
