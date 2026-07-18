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

export interface ResumeResult {
  ok: boolean;
  /** A user-facing failure reason when `ok` is false. */
  error?: string;
  /** An informational summary of what was (or wasn't) launched — maintenance/no-repo streams. */
  note?: string;
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
  const { launchPlan, noRepo, note } = planResumeLaunch(resolvedFleet, dbIssues ?? []);
  if (launchPlan.streams.length === 0 && !launchPlan.director.enabled) {
    return {
      ok: false,
      error: noRepo.length > 0
        ? `No workers to resume — ${noRepo.length} stream${noRepo.length === 1 ? "" : "s"} (${noRepo.join(", ")}) need a repo assigned.`
        : "No workers to resume.",
    };
  }

  // 3. Clear a stale warden quarantine floor so a denied command from a prior run can't immediately
  //    re-pause a relaunched worker (silent — the Planner's launch shows a confirm dialog; a graph
  //    resume just stamps the floor).
  const relaunchPanes = resolvedFleet.streams.map((st) => `${projectKey}:${st.id}`);
  store.clearProjectQuarantine(projectKey, relaunchPanes, Date.now());

  // 4. Give the director its standing protocol (bsc-fleet roster + worker Q&A) at the hub.
  if (launchPlan.director.enabled) {
    await safeInvoke("ensure_director_protocol", { projectKey }, undefined, (e) => console.error("director protocol failed:", e));
  }

  // 5. Relaunch. The director's cwd is the hub (resolved authoritatively); each worker's cwd is derived
  //    by fleetStartProject from the EXISTING worktree (no ensure_worktree re-seed — that would overwrite
  //    the worker's CLAUDE.local.md). fleetStartProject reuses the project's build tab in place, bumps its
  //    runId to remount, and switches to the Console.
  const hubPath = await safeInvoke<string>("project_dir_path", { projectKey }, "");
  const roster = store.fleetStartProject(projectName, launchPlan, projectKey, hubPath ? { hubPath } : undefined);
  publishFleetRoster(projectKey, roster);
  return { ok: true, note };
}
