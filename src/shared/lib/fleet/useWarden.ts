// The always-on warden (#1102): periodically checks every live WORKER against its trusted plan
// anchor and, on a trip, HARD-PAUSES it: kills the PTY, marks it quarantined, and fires a mobile
// push so the user is alerted even off the desktop. Two layers:
//   1. Deterministic (every tick, free): out-of-lane edit / gate-denied command → conformance.ts.
//   2. LLM judge (sampled, ~every JUDGE_EVERY ticks, needs an API key): a fuzzy "on-task?" second
//      opinion on ONE worker that catches semantic drift the rules can't see (wardenJudge.ts).
// Both feed the same hard-pause. Asymmetric by design — the watcher reads only structured, trusted
// telemetry (the plan, the git diff, the bsc-audit log), never the worker-ingested prose, so it
// can't itself be steered by an injection. Mount once at the app root so it runs on any screen.

import { useRef } from "react";
import { safeInvoke } from "../core/safeInvoke";
import { bscJson } from "../core/bsc";
import { logsTail } from "../core/logsBridge";
import { useLogStream } from "@/shared/hooks/useLogStream";
import { useAppStore } from "@/store";
import { roleCapability } from "../session/sessionRoles";
import { resolveLlmConfig, hasLlmKey, type LlmConfig } from "../core/llmConfig";
import { oneShotComplete } from "../core/claudeComplete";
import type { WorktreeChanges } from "./worktreeChanges";
import { planWarden, parseAuditCommands, zipWorktreeChanges, wardenSweepTargets, livePaneIdsOf, type WardenSession } from "./warden";
import { buildJudgePrompt, parseJudgeVerdict, selectForJudging } from "./wardenJudge";
import { completedWorkerPanes, doneIssueRefs } from "./streamCompletion";
import type { PlanIssue } from "@/features/planner/issues/planIssues";
import { log } from "../core/log";

// #3643: event-driven now — re-checks when a worker attempts a tool (`tool`/audit, the write signal
// the warden already reads), takes/finishes a turn (`activity`), or self-reports done, instead of
// re-spawning a git diff per worker every 6s. A slow safety-net backstop covers plan-only changes.
const JUDGE_EVERY = 5;  // run the LLM spot-check ~every 5 ticks (~30s), one worker, round-robin

/** Panes mid-quarantine, so a slow kill+push doesn't double-fire across ticks. */
type InFlight = { current: Set<string> };

/** Gather one live worker's trusted activity + anchor, or null if it can't be evaluated.
 *
 *  #3908: PURE of I/O now — the two reads it used to make per pane are hoisted to ONE per sweep by
 *  {@link sweepInputs} and passed in. Both were fan-out waste at fleet scale: `read_worktree_changes`
 *  spawns two git subprocesses (~78 per sweep at 39 panes, stalling the command queue ~11s), and the
 *  audit tail takes no pane argument at all — every worker was re-reading the SAME log, filtered
 *  per-pane only afterwards by `parseAuditCommands`. */
function buildSession(paneId: string, auditLines: string[], changesByPane: Map<string, string[]>): WardenSession | null {
  const st = useAppStore.getState();
  const stream = st.fleetPaneStreams[paneId];
  if (!stream) return null;
  const role = st.paneRoles[paneId] ?? "worker";
  if (role !== "worker") return null; // the warden watches workers — the exposed attack surface
  const cwd = st.paneCwds[paneId];
  if (!cwd) return null;

  const changedFiles = changesByPane.get(paneId) ?? [];
  return {
    paneId,
    anchor: {
      streamId: stream.id,
      ownedGlobs: stream.owns,
      capability: roleCapability(role, { writeGlobs: stream.owns }),
      flow: stream.flow,
    },
    activity: {
      changedFiles: changedFiles ?? [],
      // Ignore audit commands from before this pane's warden floor (set on triage relaunch) so a
      // prior run's denied command doesn't re-quarantine the freshly relaunched worker.
      commands: parseAuditCommands(auditLines ?? [], paneId, st.wardenSince[paneId] ?? 0),
    },
  };
}

/**
 * The reads a whole warden sweep shares, fetched ONCE (#3908) — the fix for the fan-out that stalled
 * the command queue ~11s at 39 panes.
 *
 * `logsTail("audit", …)` takes no pane argument, so one read serves every worker (`parseAuditCommands`
 * does the per-pane filtering). `read_worktree_changes_batch` replaces N git-spawning invokes with one,
 * index-aligned to the cwds we send. Targets mirror `buildSession`'s own guards so the batch never
 * pays for a pane that would be discarded anyway.
 */
async function sweepInputs(paneIds: string[]): Promise<{ auditLines: string[]; changesByPane: Map<string, string[]> }> {
  const st = useAppStore.getState();
  const targets = paneIds.filter((p) => {
    const stream = st.fleetPaneStreams[p];
    return !!stream && (st.paneRoles[p] ?? "worker") === "worker" && !!st.paneCwds[p];
  });
  const cwds = targets.map((p) => st.paneCwds[p] as string);
  const [auditLines, changes] = await Promise.all([
    logsTail("audit", 500),
    cwds.length ? safeInvoke<WorktreeChanges[]>("read_worktree_changes_batch", { cwds }, []) : Promise.resolve<WorktreeChanges[]>([]),
  ]);
  // Index-aligned zip (pure + unit-tested in warden.ts): a short/failed batch degrades each missing
  // pane to "no file signal", exactly as a failed single read did — never another worker's files.
  return { auditLines: auditLines ?? [], changesByPane: zipWorktreeChanges(targets, changes ?? []) };
}

/** Hard-pause a worker: kill the PTY FIRST (a hijacked session can't be trusted to stop itself),
 *  then record the quarantine and fire the mobile push. Per-pane guarded so it fires once. */
async function quarantinePane(paneId: string, streamId: string, summary: string, inFlight: InFlight): Promise<void> {
  if (inFlight.current.has(paneId)) return;
  inFlight.current.add(paneId);
  try {
    await safeInvoke("pty_kill", { paneId }, undefined, (e) => log.error(`warden: pty_kill ${paneId} failed: ${e}`));
    useAppStore.getState().markQuarantine(paneId, { streamId, summary, at: Date.now() });
    // Mobile alert (#1102 slice 2a): a "quarantine" coord event → FCM push to paired phones.
    await safeInvoke("tunnel_emit_coord_event", { kind: "quarantine", session: paneId, refKey: summary, at: Date.now() },
      undefined, (e) => log.error(`warden: quarantine push ${paneId} failed: ${e}`));
    log.warn(`warden: quarantined ${paneId} (${streamId}) — ${summary}`);
  } finally {
    inFlight.current.delete(paneId);
  }
}

/** Escalate one worker to the LLM judge; quarantine it if the judge says it drifted. Fail-open:
 *  any error / unparseable reply leaves the worker running (the deterministic check is the gate). */
async function judgeAndMaybeQuarantine(session: WardenSession, cfg: LlmConfig, inFlight: InFlight): Promise<void> {
  const stream = useAppStore.getState().fleetPaneStreams[session.paneId];
  if (!stream) return;
  const { system, user } = buildJudgePrompt({
    streamId: session.anchor.streamId,
    ownedGlobs: session.anchor.ownedGlobs,
    issues: stream.issues,
    changedFiles: session.activity.changedFiles,
    commands: session.activity.commands,
  });
  const reply = await oneShotComplete(cfg, system, user).catch((e) => {
    log.error(`warden: judge call failed for ${session.paneId}: ${e}`);
    return "";
  });
  if (!reply) return;
  const verdict = parseJudgeVerdict(reply);
  if (verdict.drifted) {
    await quarantinePane(session.paneId, session.anchor.streamId, `LLM judge: ${verdict.reason}`, inFlight);
  }
}

export function useWarden(): void {
  const inFlight = useRef<Set<string>>(new Set());
  const tickCount = useRef(0);     // drives the judge cadence
  const judgeCursor = useRef(0);   // round-robin cursor for sampling
  const judging = useRef(false);   // one judge call in flight at a time

  useLogStream(["tool", "activity", "done"], async (isCancelled) => {
    if (isCancelled()) return;
    const st = useAppStore.getState();
    const panes = Object.keys(st.fleetPaneStreams);
    if (panes.length === 0) return;

    // A worker that finished every owned issue is in MAINTENANCE (#1957), not building — its
    // post-completion activity is expected, not drift, so the warden must NOT quarantine it, and any
    // existing quarantine on it is lifted. Read each project's issue statuses once per tick (deduped by
    // project key — a worker pane id is `<projectKey>:<streamId>`).
    const projectKeys = [...new Set(panes.map((p) => p.split(":")[0]).filter(Boolean))];
    const doneByProject = new Map<string, Set<string>>();
    await Promise.all(projectKeys.map(async (key) => {
      const issues = await bscJson<PlanIssue[]>(key, ["plan", "list", "--full", "--json"], []);
      doneByProject.set(key, doneIssueRefs(issues ?? []));
    }));
    if (isCancelled()) return;
    const completed = completedWorkerPanes(st.fleetPaneStreams, (paneId) => doneByProject.get(paneId.split(":")[0]));
    for (const paneId of completed) {
      if (st.quarantinedPanes[paneId]) {
        st.clearQuarantine(paneId);
        log.info(`warden: lifted quarantine for ${paneId} — its issues are complete (in maintenance)`);
      }
    }

    const fresh = useAppStore.getState();
    const quarantined = new Set([...Object.keys(fresh.quarantinedPanes), ...inFlight.current]);
    // #3954: probe only panes with a RUNNING session, and skip completed workers entirely (they must
    // not be (re)quarantined while standing by). `panes` is the PLANNED roster — after the resume
    // rebuilt network-monitor's worktrees that was 47 panes against 3 live terminals, and every pane
    // costs two git subprocesses. A pane with no session cannot be drifting.
    const liveIds = livePaneIdsOf(fresh.tabs, fresh.endedPanes, fresh.disabledPanes);
    const live = wardenSweepTargets(panes, liveIds, completed);
    // #3908: TWO invokes per sweep, not two per pane. Was `Promise.all(live.map(buildSession))`, which
    // fired N git-spawning `read_worktree_changes` plus N identical audit tails at once.
    const { auditLines, changesByPane } = await sweepInputs(live);
    if (isCancelled()) return;
    const sessions = live
      .map((p) => buildSession(p, auditLines, changesByPane))
      .filter((s): s is WardenSession => s !== null);

    // Layer 1 — deterministic hard-pause (every tick, free).
    for (const trip of planWarden(sessions, quarantined)) {
      void quarantinePane(trip.paneId, trip.streamId, trip.summary, inFlight);
    }

    // Layer 2 — LLM-judge spot-check (sampled, gated on an API key, one call at a time).
    tickCount.current += 1;
    if (tickCount.current % JUDGE_EVERY === 0 && !judging.current) {
      const cfg = resolveLlmConfig(st);
      if (hasLlmKey(cfg)) {
        const skip = new Set([...quarantined, ...Object.keys(useAppStore.getState().quarantinedPanes)]);
        const pick = selectForJudging(sessions.map((s) => s.paneId), judgeCursor.current++, skip);
        const session = pick ? sessions.find((s) => s.paneId === pick) : undefined;
        if (session) {
          judging.current = true;
          void judgeAndMaybeQuarantine(session, cfg, inFlight).finally(() => { judging.current = false; });
        }
      }
    }
  }, []);
}
