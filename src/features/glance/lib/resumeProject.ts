// resumeProjectFleet (#glance-resume) — one-click "bring this project's fleet back to life" from the
// Glance graph. It is the progress-gated relaunch the Planner runs (usePlanPublish.launchTriage),
// distilled to what a RESUME of an already-published, already-launched project needs — no publish, no
// sandbox, no quarantine dialog, no UI-pairing re-seed. A project only reaches the Glance network once
// its fleet/triage has launched (useGlanceProjects.filterTriaged), so its worktrees + each worker's
// CLAUDE.local.md already exist on disk; the resume therefore does NOT re-run ensure_worktree (which
// would overwrite the worker scope with a thinner one) — it lets fleetStartProject derive each worker's
// cwd from the existing worktree and resumes the session via `claude --continue` (fleetStartProject
// sets paneContinue on a re-run of an existing build tab).
//
// fleetStartProject itself navigates to the Console and focuses the build tab, so the caller doesn't.

import { useAppStore } from "@/store";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { log } from "@/shared/lib/core/log";
import { bscJson } from "@/shared/lib/core/bsc";
import { parseFleetFile, withDerivedStreamIssues, type FleetPlan } from "@/features/planner/fleet/planFleet";
import { pruneCompletedStreams, doneIssueRefs } from "@/shared/lib/fleet/streamCompletion";
import { resolveClosedRefs } from "./fleetIssueState";
import { publishFleetRoster } from "@/shared/lib/fleet/fleetRoster";
import type { PlanIssue } from "@/features/planner/issues/planIssues";
import { buildWorkerScope } from "@/features/planner/fleet/workerScope";
import { isAgentWorktreeCwd } from "@/shared/lib/core/projectPaths";
import { parseDependencyManifest, depsForRepo } from "@/features/planner/issues/dependencies";
import { partitionByDeps, heldReason, sessionDoneStreams, type LandedEvidence } from "@/shared/lib/fleet/streamGate";
import { readCoordState } from "@/shared/lib/fleet/useCoordLog";
import { ensureClaudeRunning } from "@/shared/lib/session/ensureClaudeRunning";

export interface ResumeResult {
  ok: boolean;
  /** A user-facing failure reason when `ok` is false. */
  error?: string;
  /** An informational summary of what was (or wasn't) launched — maintenance/no-repo streams. */
  note?: string;
  /** Sessions deliberately NOT relaunched, with why (#3916). The caller SURFACES these — opens their
   *  nodes so the user sees the problem — rather than resuming past them silently. */
  blocked?: BlockedStream[];
  /** Streams HELD by the dependency gate (#3931) — not started because an upstream hasn't landed.
   *  Distinct from `blocked`: nothing is wrong with these, they are simply not their turn yet, so the
   *  caller reports them without opening error nodes. */
  held?: BlockedStream[];
}

/** A session a resume refused to relaunch, and why (#3916). */
export interface BlockedStream {
  streamId: string;
  paneId: string;
  reason: string;
}

/**
 * Is there genuinely NOTHING for a project resume to start (#3923)? True only when every pane is already
 * live or is quarantined — the two states a resume must not touch (a live one is running; a quarantined
 * one is surfaced, never relaunched, #3916).
 *
 * This replaced a guard that bailed on the FIRST live pane, which made ▶ Resume permanently inert once a
 * single node had been resumed on its own: the "turn them all back on" button just switched screens. A
 * live pane is safe to include in the relaunch — `pty_create` reconnects to an existing session and
 * returns before spawning, so it never re-sends `claude --continue` to a running agent.
 */
export function nothingToResume(
  paneIds: readonly string[],
  livePaneIds: ReadonlySet<string>,
  quarantined: Record<string, unknown>,
): boolean {
  if (paneIds.length === 0) return false; // no tab yet ⇒ there IS work (build it)
  return paneIds.every((pid) => livePaneIds.has(pid) || !!quarantined[pid]);
}

/**
 * Split the streams a resume WOULD launch into those that can actually run and those that cannot (#3916).
 * Pure — the IO (worktree existence) is probed by the caller and injected — so the whole rule is
 * exhaustively testable, like {@link planResumeLaunch} beside it.
 *
 * Two blocking conditions, both of which must SURFACE rather than be silently worked around:
 *  · QUARANTINED — the warden hard-paused this worker. Resume used to call `clearProjectQuarantine`,
 *    wiping the warden floor so a prior run's denied command couldn't re-pause it; that discarded the
 *    exact signal the user needs. A quarantined worker now stays quarantined and becomes visible.
 *  · WORKTREE MISSING — #3614: the boot-GC reclaims a merged+clean worktree and the boot reconcile marks
 *    that worker ended. Relaunching it would spawn a session into a NON-EXISTENT cwd — the burst of
 *    doomed sessions that jams the backend. Never launch it; report it.
 */
/**
 * The panes that FINISHED (#4029) — the two ways a worker ends well:
 *   · `bsc-maintain` → `paneMaintaining` (declared: everything I own is done, standing by)
 *   · `bsc-done` → `endedPanes` with a `done` VERDICT, which comes from plan.db owned-issue status
 *     rather than the worker's say-so.
 *
 * `needs-attention` / `blocked` endings are deliberately NOT here: those are endings that want a
 * person, so they stay resumable and keep reporting themselves.
 *
 * Exported so both the project resume and the single-node resume ask the same question — the
 * single-node path had its own hole, and two independent notions of "finished" would drift.
 */
export function completedPanes(store: {
  paneMaintaining: Record<string, boolean>;
  endedPanes: Record<string, { state: string } | undefined>;
}): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [paneId, on] of Object.entries(store.paneMaintaining)) if (on) out.add(paneId);
  for (const [paneId, info] of Object.entries(store.endedPanes)) if (info?.state === "done") out.add(paneId);
  return out;
}

export function partitionResumable(
  streams: Array<{ id: string }>,
  projectKey: string,
  probes: {
    quarantined: Record<string, { summary?: string } | undefined>;
    missingWorktreePanes: ReadonlySet<string>;
    /** Panes that FINISHED (#4029) — declared maintenance, or auto-ended with a `done` verdict. */
    completePanes?: ReadonlySet<string>;
  },
): { resumable: Array<{ id: string }>; blocked: BlockedStream[]; complete: Array<{ id: string }> } {
  const resumable: Array<{ id: string }> = [];
  const blocked: BlockedStream[] = [];
  const complete: Array<{ id: string }> = [];
  for (const st of streams) {
    const paneId = `${projectKey}:${st.id}`;
    const q = probes.quarantined[paneId];
    if (q) {
      blocked.push({ streamId: st.id, paneId, reason: q.summary?.trim() || "quarantined by the warden" });
      continue;
    }
    if (probes.missingWorktreePanes.has(paneId)) {
      blocked.push({ streamId: st.id, paneId, reason: "its worktree is gone and could not be rebuilt (no repo clone?)" });
      continue;
    }
    // FINISHED (#4029) — left alone. Relaunching a worker that has completed everything it owns undoes
    // the reclaim (#4025) and puts an agent back on the model for no reason. It is woken by the thing
    // that has actual work for it: a director `bsc-assign`, which relaunches with the assignment baked
    // in. That is the point of reclaiming it — it comes back FOR A REASON, not because a button was
    // pressed.
    //
    // Its OWN bucket, not `blocked`: blocked means "needs attention" and is reported to the user as
    // such, so filing completions there would make a healthy finished fleet look broken.
    if (probes.completePanes?.has(paneId)) {
      complete.push(st);
      continue;
    }
    resumable.push(st);
  }
  return { resumable, blocked, complete };
}

/**
 * Decide, from a project's fleet plan and its current plan.db issue statuses, exactly which streams to
 * (re)launch on a resume — the SAME progress-gated rule the Planner uses (#1004/#1957): a stream whose
 * every owned issue is done relaunches into MAINTENANCE (stays alive, ready for the director) rather than
 * being skipped; a stream with outstanding work relaunches ACTIVE; a stream with no resolvable repo can't
 * spawn a worktree so it's dropped with a note. Pure (no IO) so it's exhaustively unit-testable.
 */
export function planResumeLaunch(
  fleet: FleetPlan,
  dbIssues: Array<{ ref?: string; stream?: string; status?: string }>,
  /** Refs some OTHER evidence source reports finished — today the GitHub overlay (#4103), in each
   *  stream's own ref spelling. Unioned with plan.db's terminal rows: either source calling a ref done
   *  makes it done, because neither is complete on its own. plan.db knows only what a planner run
   *  authored (nothing, for a hand-assembled fleet); GitHub knows only what a token could reach.
   *  Optional so this stays PURE and exhaustively unit-testable. */
  extraDone: ReadonlySet<string> = new Set(),
): { launchPlan: FleetPlan; maintenanceIds: Set<string>; noRepo: string[]; note?: string } {
  const done = new Set([...doneIssueRefs(dbIssues as PlanIssue[]), ...extraDone]);
  const { active, maintenance } = pruneCompletedStreams(fleet.streams, done);
  const maintenanceIds = new Set(maintenance.map((s) => s.id));
  // A stream with no repo stays visible in the plan but can't get a worktree — drop it here and report it.
  const withRepo = [...active, ...maintenance].filter((st) => st.repo);
  const noRepo = [...active, ...maintenance].filter((st) => !st.repo).map((st) => st.id);
  // Enrich each launched stream's issue list from plan.db (a stream can reach launch with an empty
  // issues[] even though issues name it as their owning stream) so its worker/kickoff sees its tasks.
  const launchable = withDerivedStreamIssues(withRepo, dbIssues);
  const launchPlan: FleetPlan = { ...fleet, streams: launchable };

  const notes: string[] = [];
  if (noRepo.length > 0) {
    notes.push(`${noRepo.length} stream${noRepo.length === 1 ? "" : "s"} (${noRepo.join(", ")}) skipped — no repo assigned`);
  }
  if (maintenance.length > 0) {
    notes.push(`${maintenance.length} completed worker${maintenance.length === 1 ? "" : "s"} `
      + `(${maintenance.map((s) => s.id).join(", ")}) relaunching into maintenance`
      + (active.length > 0 ? `; ${active.length} active` : ""));
  }
  return { launchPlan, maintenanceIds, noRepo, note: notes.length ? notes.join(". ") + "." : undefined };
}

/**
 * Resume a project's whole fleet from the Glance graph. Loads the fleet (a caller-supplied plan when
 * available, else the store mirror, else the project's plan.db), progress-gates it against plan.db issue
 * statuses, clears a stale warden quarantine floor, ensures the director has its standing protocol, and
 * relaunches via `fleetStartProject` — which reopens the `· build` tab (director + one pane per
 * outstanding stream, resuming each with `claude --continue`) and switches to the Console.
 *
 * `fleet` lets the drilled-project caller pass the fleet it already loaded (useProjectFleet) so the
 * resume doesn't re-read plan.db for it. Returns a ResumeResult; a false `ok` carries a user-facing reason.
 */
export async function resumeProjectFleet(opts: {
  projectName: string;
  projectKey: string;
  fleet?: FleetPlan | null;
}): Promise<ResumeResult> {
  const { projectName, projectKey } = opts;
  const store = useAppStore.getState();

  // Guard the #905/#1819 hazard: with no base dir loaded, fleetStartProject would derive every worker's
  // cwd as the user's home. It's loaded well before the user reaches Glance, so this only trips on a
  // race — surface it rather than launch sessions at the wrong dir.
  if (!store.bscBaseDir) {
    return { ok: false, error: "Workspace is still loading — try Resume again in a moment." };
  }

  // 1. Resolve the fleet: caller-supplied → store mirror → the project's own plan.db.
  let fleet: FleetPlan | null = opts.fleet ?? store.planFleet[projectKey] ?? null;
  if (!fleet || fleet.streams.length === 0) {
    const raw = await bscJson<unknown | null>(projectKey, ["plan", "fleet", "get", "--full", "--json"], null);
    fleet = raw ? parseFleetFile(JSON.stringify(raw)) : null;
  }
  if (!fleet || (fleet.streams.length === 0 && !fleet.director.enabled)) {
    return { ok: false, error: "No planned fleet to resume for this project." };
  }
  // Capture the narrowed fleet in a const so its non-null type survives the awaits below.
  const resolvedFleet = fleet;

  // 2. Progress-gate against plan.db.
  const dbIssues = await bscJson<PlanIssue[]>(projectKey, ["plan", "list", "--full", "--json"], []);
  // #4103: plan.db's `issues` table is EMPTY for a fleet assembled outside a full planner run (measured:
  // 40 streams, 0 issue rows), so `doneIssueRefs` returned nothing and NO stream ever read as complete —
  // a relaunch restarted finished workers and maintenance mode (#1957) never engaged. The stream's own
  // refs are the ownership record; GitHub says which are closed. One batched query per repo.
  const closedRefs = await resolveClosedRefs(resolvedFleet.streams);
  const { launchPlan, maintenanceIds, noRepo, note: gateNote } =
    planResumeLaunch(resolvedFleet, dbIssues ?? [], closedRefs);
  if (launchPlan.streams.length === 0 && !launchPlan.director.enabled) {
    return {
      ok: false,
      error: noRepo.length > 0
        ? `No workers to resume — ${noRepo.length} stream${noRepo.length === 1 ? "" : "s"} (${noRepo.join(", ")}) need a repo assigned.`
        : "No workers to resume.",
    };
  }

  // 2b. THE DEPENDENCY GATE (#3931). Until now a resume started every stream at once — 38 simultaneous
  //     `claude --continue` sessions on the live fleet, which is both the lag the user feels and simply
  //     wrong: a stream whose upstream hasn't landed has nothing to build against. `dependsOn` already
  //     carries the graph (plan.db, 37 of 38 populated); this is the launch-time consumer #1039 left
  //     missing. Nothing PARKS — a held stream is never started, and a started one never waits — so
  //     #1039's objection (a parked worker is a worker not working) still stands.
  //
  //     `fleet_landed_streams` is the durable evidence: one `git branch --merged HEAD` per repo. See
  //     streamGate.ts for why the issue-keyed and session-keyed latches are BOTH empty on every live
  //     project and would hang the fleet if trusted alone.
  const [mergedBranches, coord] = await Promise.all([
    safeInvoke<string[]>("fleet_landed_streams", { projectKey }, []),
    readCoordState(),
  ]);
  const evidence: LandedEvidence = {
    doneIssues: new Set([...doneIssueRefs((dbIssues ?? []) as PlanIssue[]), ...closedRefs]),
    mergedBranches: new Set(mergedBranches ?? []),
    // Tier 3: a worker that finished its lane parks in MAINTENANCE (#1957, `bsc-maintain`) — the one
    // per-session completion signal that is actually populated in the live log (34 events, each keyed
    // `<projectKey>:<streamId>`). `readCoordState` returns null on a read failure, in which case tier 3
    // contributes nothing and tiers 1-2 still decide: a failed read must withhold evidence, never
    // fabricate it, or a transient log error would release the whole fleet at once.
    sessionDone: sessionDoneStreams(coord?.state.maintaining ?? [], projectKey),
  };
  const gate = partitionByDeps(launchPlan.streams, evidence);
  // A landed stream relaunches into MAINTENANCE rather than build. This is the same rule
  // `pruneCompletedStreams` applies via issues — extended with branch evidence, which is what makes it
  // work at all on a 0-issue fleet (where nothing was ever routed to maintenance and every stream
  // relaunched into a build it had already finished).
  for (const st of gate.landed) maintenanceIds.add(st.id);
  const heldIds = new Set(gate.held.map((h) => h.streamId));
  const held: BlockedStream[] = gate.held.map((h) => ({
    streamId: h.streamId, paneId: `${projectKey}:${h.streamId}`, reason: heldReason(h),
  }));
  launchPlan.streams = launchPlan.streams.filter((st) => !heldIds.has(st.id));
  if (launchPlan.streams.length === 0 && !launchPlan.director.enabled) {
    const cycle = gate.held.some((h) => h.deadlocked);
    return {
      ok: false,
      error: cycle
        ? "Nothing can start — the fleet's dependsOn graph has a cycle."
        : `Nothing can start yet — all ${held.length} stream${held.length === 1 ? " is" : "s are"} waiting on an upstream.`,
      held,
    };
  }

  // 3. Partition (#3916). Resume relaunches what can actually RUN and SURFACES what cannot, instead of
  //    steamrolling both. This deliberately replaces the old `clearProjectQuarantine` call, which wiped
  //    the warden floor so a prior run's denied command couldn't re-pause a worker — that silently
  //    discarded the one signal the user has to act on.
  const candidateStreams = launchPlan.streams;
  const paneOf = (id: string) => `${projectKey}:${id}`;
  // RECREATE a reclaimed worktree rather than refuse it (#3920). #3614's boot-GC reclaims a merged+clean
  // worktree and the boot reconcile marks that worker ended; #3916 then (correctly) refused to spawn into
  // the missing cwd, which meant a project whose worktrees had all been reclaimed could never resume at
  // all. But nothing is lost in that state: the repo clone and every stream BRANCH still exist, and
  // `ensure_worktree` explicitly reuses a leftover branch — so the worker comes back on its own history.
  // Seed the SAME scope the Planner's launch seeds (`buildWorkerScope` + the repo's locked deps, #1111),
  // or the rebuilt worker would return with a thinner CLAUDE.local.md than it had.
  const depManifest = parseDependencyManifest(
    JSON.stringify(await bscJson<unknown>(projectKey, ["plan", "deps", "get", "--json"], {}) ?? {}),
  ).dependencies;
  const worktreePaths: Record<string, string> = {};
  const unrecoverable = new Set<string>();
  await Promise.all(candidateStreams.map(async (st) => {
    const paneId = paneOf(st.id);
    if (store.quarantinedPanes[paneId]) return;          // quarantine is surfaced, never rebuilt
    const cwd = store.paneCwds[paneId];
    // #3937: reuse a persisted cwd ONLY when it still looks like this agent's own worktree. "The
    // directory exists" is not enough: while a worktree was missing the pane's shell sat in the
    // fallback ancestor (`worktrees/<key>`) and OSC 7 reported that ancestor back into `paneCwds`,
    // so the stored path became one that both exists and is wrong — and an existence check passes
    // for it forever. The shape check re-derives instead, which repairs an already-poisoned pane.
    if (cwd && st.repo && !isAgentWorktreeCwd(cwd, st.repo, st.id)) {
      log.warn(`resume: ${paneId} had a cwd outside its own worktree (${cwd}) — re-deriving (#3937)`);
    } else if (cwd && await safeInvoke<boolean>("dir_exists", { path: cwd }, true)) {
      worktreePaths[st.id] = cwd;                        // still there and still ours — reuse verbatim
      return;
    }
    if (!st.repo) { unrecoverable.add(paneId); return; } // no repo ⇒ no worktree is possible
    const scopeMd = buildWorkerScope(st, depsForRepo(depManifest, st.repo), maintenanceIds.has(st.id));
    const path = await safeInvoke<string>("ensure_worktree",
      { projectKey, repo: st.repo, agentId: st.id, scopeMd }, "");
    if (path) worktreePaths[st.id] = path;
    else unrecoverable.add(paneId);                      // clone missing / git failed — surface it
  }));
  const { resumable, blocked, complete } = partitionResumable(candidateStreams, projectKey, {
    quarantined: store.quarantinedPanes,
    missingWorktreePanes: unrecoverable,
    completePanes: completedPanes(store),
  });
  if (resumable.length === 0 && !launchPlan.director.enabled) {
    return {
      ok: false,
      error: blocked.length > 0
        ? `Nothing resumable — ${blocked.length} session${blocked.length === 1 ? "" : "s"} need attention.`
        : complete.length > 0
          // Not an error state dressed as one: everything finished. Say that, and say what wakes them.
          ? `Nothing to resume — all ${complete.length} worker(s) are complete. The director wakes one when it dispatches work.`
          : "No workers to resume.",
      blocked,
      held,
    };
  }
  // Only the resumable streams launch; the blocked ones keep their quarantine/ended state untouched.
  const resumableIds = new Set(resumable.map((st) => st.id));
  launchPlan.streams = launchPlan.streams.filter((st) => resumableIds.has(st.id));

  // 3b. Clear the ENDED flag for exactly the panes we are relaunching (#3916). Without this the whole
  //     resume was a no-op: `TerminalView` bails before `pty_create` when `endedPanes[paneId]` is set,
  //     and `endedPanes` is persisted — so a worker ended by completion (#920) or by the boot-GC
  //     worktree reconcile (#3614) could never be revived by a project resume. Cleared BEFORE
  //     `fleetStartProject` so the remount it triggers already sees a clean flag.
  store.clearEndedPanes([...resumableIds].map(paneOf));

  // 4. Give the director its standing protocol (bsc-fleet roster + worker Q&A) at the hub.
  if (launchPlan.director.enabled) {
    await safeInvoke("ensure_director_protocol", { projectKey }, undefined, (e) => console.error("director protocol failed:", e));
  }

  // 5. Relaunch. The director's cwd is the hub (resolved authoritatively); each worker's cwd is derived
  //    by fleetStartProject from the EXISTING worktree (no ensure_worktree re-seed — that would overwrite
  //    the worker's CLAUDE.local.md). fleetStartProject reuses the project's build tab in place, bumps its
  //    runId to remount, and switches to the Console.
  const hubPath = await safeInvoke<string>("project_dir_path", { projectKey }, "");
  // #905: hand the AUTHORITATIVE cwds (hub + each rebuilt/reused worktree) to the launch so no pane
  // falls back to a bscBaseDir-derived guess.
  const roster = store.fleetStartProject(projectName, launchPlan, projectKey, { hubPath: hubPath || undefined, worktreePaths });
  publishFleetRoster(projectKey, roster);

  // 6. Revive any pane whose PTY is still alive but idle (#3998).
  //
  //    `fleetStartProject` issues no Tauri commands — it bumps the tab's `runId` and rewrites store
  //    state. That re-keys the pane SLOTS, but `TerminalView` is portal-hosted by `paneId`, so a pane
  //    that never left the tab does not remount, never calls `pty_create`, and never runs the
  //    `claude --continue` this resume just resolved for it. Panes that DID unmount (ended/dormant,
  //    cleared in 3b above) remount and are handled by the reconnect branch in `TerminalView`.
  //
  //    Awaited so the caller's `ok` genuinely means the resume was attempted; the probe itself is one
  //    batched call regardless of how many panes are listed.
  await ensureClaudeRunning([...resumableIds].map(paneOf));
  const notes = [gateNote, complete.length > 0
    ? `${complete.length} complete worker${complete.length === 1 ? "" : "s"} left alone — the director wakes them on dispatch`
    : undefined, held.length > 0
    ? `${held.length} stream${held.length === 1 ? "" : "s"} held — waiting on an upstream to land`
    : undefined].filter(Boolean);
  return { ok: true, note: notes.length ? notes.join(". ") + "." : undefined, blocked, held };
}
