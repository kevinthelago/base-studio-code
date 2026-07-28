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
import { bscJson } from "@/shared/lib/core/bsc";
import { parseFleetFile, withDerivedStreamIssues, type FleetPlan } from "@/features/planner/fleet/planFleet";
import { pruneCompletedStreams, doneIssueRefs } from "@/shared/lib/fleet/streamCompletion";
import { publishFleetRoster } from "@/shared/lib/fleet/fleetRoster";
import type { PlanIssue } from "@/features/planner/issues/planIssues";
import { buildWorkerScope } from "@/features/planner/fleet/workerScope";
import { parseDependencyManifest, depsForRepo } from "@/features/planner/issues/dependencies";

export interface ResumeResult {
  ok: boolean;
  /** A user-facing failure reason when `ok` is false. */
  error?: string;
  /** An informational summary of what was (or wasn't) launched — maintenance/no-repo streams. */
  note?: string;
  /** Sessions deliberately NOT relaunched, with why (#3916). The caller SURFACES these — opens their
   *  nodes so the user sees the problem — rather than resuming past them silently. */
  blocked?: BlockedStream[];
}

/** A session a resume refused to relaunch, and why (#3916). */
export interface BlockedStream {
  streamId: string;
  paneId: string;
  reason: string;
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
export function partitionResumable(
  streams: Array<{ id: string }>,
  projectKey: string,
  probes: { quarantined: Record<string, { summary?: string } | undefined>; missingWorktreePanes: ReadonlySet<string> },
): { resumable: Array<{ id: string }>; blocked: BlockedStream[] } {
  const resumable: Array<{ id: string }> = [];
  const blocked: BlockedStream[] = [];
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
    resumable.push(st);
  }
  return { resumable, blocked };
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
): { launchPlan: FleetPlan; maintenanceIds: Set<string>; noRepo: string[]; note?: string } {
  const { active, maintenance } = pruneCompletedStreams(fleet.streams, doneIssueRefs(dbIssues as PlanIssue[]));
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
  const { launchPlan, maintenanceIds, noRepo, note } = planResumeLaunch(resolvedFleet, dbIssues ?? []);
  if (launchPlan.streams.length === 0 && !launchPlan.director.enabled) {
    return {
      ok: false,
      error: noRepo.length > 0
        ? `No workers to resume — ${noRepo.length} stream${noRepo.length === 1 ? "" : "s"} (${noRepo.join(", ")}) need a repo assigned.`
        : "No workers to resume.",
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
    if (cwd && await safeInvoke<boolean>("dir_exists", { path: cwd }, true)) {
      worktreePaths[st.id] = cwd;                        // still there — reuse it verbatim
      return;
    }
    if (!st.repo) { unrecoverable.add(paneId); return; } // no repo ⇒ no worktree is possible
    const scopeMd = buildWorkerScope(st, depsForRepo(depManifest, st.repo), maintenanceIds.has(st.id));
    const path = await safeInvoke<string>("ensure_worktree",
      { projectKey, repo: st.repo, agentId: st.id, scopeMd }, "");
    if (path) worktreePaths[st.id] = path;
    else unrecoverable.add(paneId);                      // clone missing / git failed — surface it
  }));
  const { resumable, blocked } = partitionResumable(candidateStreams, projectKey, {
    quarantined: store.quarantinedPanes,
    missingWorktreePanes: unrecoverable,
  });
  if (resumable.length === 0 && !launchPlan.director.enabled) {
    return {
      ok: false,
      error: blocked.length > 0
        ? `Nothing resumable — ${blocked.length} session${blocked.length === 1 ? "" : "s"} need attention.`
        : "No workers to resume.",
      blocked,
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
  return { ok: true, note, blocked };
}
