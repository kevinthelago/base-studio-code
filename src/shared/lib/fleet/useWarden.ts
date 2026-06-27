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
import { usePoll } from "@/shared/hooks/usePoll";
import { useAppStore } from "@/store";
import { roleCapability } from "../session/sessionRoles";
import { resolveLlmConfig, hasLlmKey, type LlmConfig } from "../core/llmConfig";
import { oneShotComplete } from "../core/claudeComplete";
import { planWarden, parseAuditCommands, type WardenSession } from "./warden";
import { buildJudgePrompt, parseJudgeVerdict, selectForJudging } from "./wardenJudge";
import { log } from "../core/log";

const POLL_MS = 6000;   // heavier than the coord loop (reads a git diff per worker) — every ~6s
const JUDGE_EVERY = 5;  // run the LLM spot-check ~every 5 ticks (~30s), one worker, round-robin

/** Panes mid-quarantine, so a slow kill+push doesn't double-fire across ticks. */
type InFlight = { current: Set<string> };

/** Gather one live worker's trusted activity + anchor, or null if it can't be evaluated. */
async function buildSession(paneId: string): Promise<WardenSession | null> {
  const st = useAppStore.getState();
  const stream = st.fleetPaneStreams[paneId];
  if (!stream) return null;
  const role = st.paneRoles[paneId] ?? "worker";
  if (role !== "worker") return null; // the warden watches workers — the exposed attack surface
  const cwd = st.paneCwds[paneId];
  if (!cwd) return null;

  const changedFiles = await safeInvoke<string[]>("read_worktree_changes", { cwd }, []);
  const auditLines = await safeInvoke<string[]>("read_audit_log", { limit: 500 }, []);
  return {
    paneId,
    anchor: {
      streamId: stream.id,
      ownedGlobs: stream.owns,
      capability: roleCapability(role, { writeGlobs: stream.owns }),
      flow: stream.flow,
    },
    activity: { changedFiles: changedFiles ?? [], commands: parseAuditCommands(auditLines ?? [], paneId) },
  };
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

  usePoll(async (isCancelled) => {
    if (isCancelled()) return;
    const st = useAppStore.getState();
    const panes = Object.keys(st.fleetPaneStreams);
    if (panes.length === 0) return;

    const quarantined = new Set([...Object.keys(st.quarantinedPanes), ...inFlight.current]);
    const sessions = (await Promise.all(panes.map(buildSession))).filter((s): s is WardenSession => s !== null);
    if (isCancelled()) return;

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
  }, POLL_MS, []);
}
