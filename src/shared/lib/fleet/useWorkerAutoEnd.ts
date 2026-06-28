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
import { safeInvoke } from "../core/safeInvoke";
import { usePoll } from "@/shared/hooks/usePoll";
import { useAppStore } from "@/store";
import { emptyCoordState } from "./coordination";
import { readCoordState } from "./useCoordLog";
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

  const issues = await safeInvoke<OwnedIssue[] | null>("plan_list_issues", { projectKey, stream: stream.id }, null,
    (e) => log.error(`auto-end: plan_list_issues failed for ${paneId}: ${e}`));
  if (!issues) return;

  const coord = (await readCoordState(5000))?.state ?? emptyCoordState();

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
      await safeInvoke("pty_write", { paneId: directorPane, data: `${msg}\r` }, undefined);
    }
  }
  // bsc-done (#1379): the worker is still live and asked to close, so actually kill its PTY.
  if (opts.kill) {
    await safeInvoke("pty_kill", { paneId }, undefined, (e) => log.error(`auto-end: pty_kill failed for ${paneId}: ${e}`));
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
  usePoll(async (isCancelled) => {
    const done = await safeInvoke<string[]>("read_done_panes", undefined, []);
    if (isCancelled() || !Array.isArray(done)) return;
    const s = useAppStore.getState();
    for (const paneId of done) {
      if (s.endedPanes[paneId] || !s.fleetPaneStreams[paneId]) continue;
      await evaluateExit(paneId, { kill: true });
    }
  }, 2000, []);

  // Idle close-nudge (#1379 stage 3): for each at-rest worker, decide via the pure core whether to
  // nudge it to self-close. A worker that's question-free, idle past the short window, and whose
  // owned issues all read complete in plan.db gets ONE "wrap up / bsc-done" prompt; the nudge
  // re-arms when its turn reopens. A worker paused for the user (coord.waiting) is left alone, and
  // an outstanding director question routes to the resurface path (stage 4), never a close.
  const nudgedRef = useRef<Set<string>>(new Set());
  const resurfacedRef = useRef<Set<string>>(new Set()); // lost-ask resurfaces, one per stale ask
  usePoll(async (isCancelled) => {
    const activity = await safeInvoke<ActivityRow[]>("read_pane_activity", undefined, []);
    const coordRes = await readCoordState(5000);
    if (isCancelled() || !Array.isArray(activity)) return;
    const coord = coordRes?.state ?? emptyCoordState();
    const s = useAppStore.getState();
    const now = Date.now();
    for (const paneId of Object.keys(s.fleetPaneStreams)) {
      if (s.endedPanes[paneId] || (s.paneRoles[paneId] ?? "worker") !== "worker") continue;
      const act = activity.find((a) => a.pane === paneId);
      if (act?.state === "run") { nudgedRef.current.delete(paneId); resurfacedRef.current.delete(paneId); continue; } // working → re-arm
      if (coord.waiting.some((w) => w.session === paneId)) continue;             // paused for the user → leave it
      if (!coord.asking.some((a) => a.session === paneId)) resurfacedRef.current.delete(paneId); // ask answered → re-arm resurface
      const stream = s.fleetPaneStreams[paneId];
      const projectKey = s.tabs.find((t) => t.paneIds?.includes(paneId))?.projectKey;
      if (!projectKey || !stream) continue;
      const issues = await safeInvoke<OwnedIssue[] | null>("plan_list_issues", { projectKey, stream: stream.id }, null);
      if (isCancelled() || !issues) continue;
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
        await safeInvoke("pty_write", { paneId, data: `${CLOSE_NUDGE}\r` }, undefined);
      } else if (action === "resurface-question" && !resurfacedRef.current.has(paneId)) {
        // Lost-question resurface (#1379 stage 4): the worker has waited too long on a director
        // answer — its ask may have been missed. Re-surface it to the live director ONCE so it
        // handles it when ready (never close it, never make the worker repeat itself). Re-arms
        // once the ask is answered (it drops out of coord.asking; cleared above).
        const ask = coord.asking.find((a) => a.session === paneId);
        const directorPane = `${projectKey}:director`;
        if (ask && s.paneRoles[directorPane] === "director") {
          resurfacedRef.current.add(paneId);
          const waited = Math.max(1, Math.round((now - ask.at) / 60_000));
          const msg = `Worker ${stream.id} (${paneId}) asked "${ask.question}" ~${waited}m ago and is still waiting with no answer — it may have been missed. Answer it when ready: echo "<answer>" | bsc-answer ${paneId} (or reassign). Don't leave it parked.`;
          log.info(`auto-end: resurfacing ${paneId}'s lost question to the director`);
          await safeInvoke("pty_write", { paneId: directorPane, data: `${msg}\r` }, undefined);
        }
      }
    }
  }, IDLE_POLL_MS, []);

  // Reclaim a finished worker's worktree once its branch is MERGED (#worktree-disk). Gated on the
  // pane already being ENDED (its work is pushed) AND the PR merged on GitHub — the authoritative
  // remote signal the boot-GC's local merge check can't see. Teardown runs once per pane; the
  // boot-GC remains the fallback for anything missed (and never removes a dirty/unmerged worktree).
  const tornDownRef = useRef<Set<string>>(new Set());
  usePoll(async (isCancelled) => {
    const s = useAppStore.getState();
    const token = s.githubToken;
    if (!token) return;
    for (const paneId of Object.keys(s.endedPanes)) {
      if (tornDownRef.current.has(paneId)) continue;
      if ((s.paneRoles[paneId] ?? "worker") !== "worker") continue;
      const ps = s.paneStream[paneId];               // { repo, branch }
      const stream = s.fleetPaneStreams[paneId];      // AgentStream (.id = the worktree slug source)
      const projectKey = s.tabs.find((t) => t.paneIds?.includes(paneId))?.projectKey;
      if (!ps || !stream || !projectKey) continue;
      const owner = ps.repo.split("/")[0];
      const prs = await safeInvoke<Array<{ merged_at: string | null }> | null>(
        "github_request",
        { token, path: `repos/${ps.repo}/pulls?state=all&head=${owner}:${ps.branch}&per_page=1` },
        null,
      );
      if (isCancelled()) return;
      if (!Array.isArray(prs) || prs[0]?.merged_at == null) continue; // not merged yet — keep it
      tornDownRef.current.add(paneId); // reclaim once
      log.info(`teardown: stream ${stream.id} merged → reclaiming its worktree`);
      await safeInvoke("teardown_worktree", { projectKey, repo: ps.repo, agentId: stream.id }, undefined,
        (e) => log.error(`teardown_worktree failed for ${stream.id}: ${e}`));
    }
  }, 60_000, []);
}
