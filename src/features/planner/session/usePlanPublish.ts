// usePlanPublish (#1490) — the publish → GitHub + triage-launch + GitHub→plan.db recovery cluster,
// extracted verbatim from Planning.tsx. Owns the triage/publish/recovery state (no render loop —
// just callbacks + a recovery probe effect); takes the plan data it reads as a params object so the
// bodies move unchanged. Returns the callbacks + the state the JSX consumes.

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke, fireInvoke } from "@/shared/lib/core/safeInvoke";
import { bscJson, bscWrite } from "@/shared/lib/core/bsc";
import { useAppStore } from "@/store";
import { useConfirmDialog } from "@/shared/ui/overlay/promptDialog";
import type { Section } from "../github/ghStructure";
import { type GhStatusMap } from "./GitHubStructureCard";
import { deriveProjectTitle } from "./projectTitle";
import { parseFeaturesFile } from "../issues/featureList";
import { parseDependencyManifest, depsForRepo } from "../issues/dependencies";
import { buildWorkerScope, toWorkerUiPairing } from "../fleet/workerScope";
import { effectiveHarness } from "@/shared/lib/core/llmConfig";
import { type PlanIssue } from "../issues/planIssues";
import { pruneCompletedStreams, doneIssueRefs } from "@/shared/lib/fleet/streamCompletion";
import { resolveClosedRefs } from "@/features/glance";
import { withDerivedStreamIssues } from "../fleet/planFleet";
import { teamRoleStreams } from "../fleet/teamFleet";
import { recoverIssues, type GitHubIssueLike } from "../issues/recoverIssues";
import { removeDbProject } from "../list/projectsDbBridge";
import { publishFleetRoster } from "@/shared/lib/fleet/fleetRoster";
import { canLaunchTriage, publishBlockReason } from "@/shared/lib/github/projectSync";
import {
  type GhApi, type Upd, seedPublishStatus,
  publishRepositories, scaffoldRepositories, ensureProjectBoard, createIssues, applyStreamLabels,
  materializeIssues,
} from "./publishSteps";

export type PublishPhase = "idle" | "running" | "done" | "error";

type Store = ReturnType<typeof useAppStore.getState>;

export interface PlanPublishDeps {
  githubToken: string;
  publishRepos: string[];
  injectionGateState: { cleared: boolean; findings: unknown[]; mode: string };
  sections: Section[];
  planningTitle: string;
  activeProjectName: string;
  planFleet: Store["planFleet"];
  effectiveProjectId: string;
  activeProjectId: Store["activeProjectId"];
  activeProjectNumber: Store["activeProjectNumber"];
  planFeatures: ReturnType<typeof parseFeaturesFile>;
  planDependencies: ReturnType<typeof parseDependencyManifest>["dependencies"];
  depManifest: ReturnType<typeof parseDependencyManifest>;
  repoPublic: Store["repoPublic"];
  reposPublic: Record<string, boolean>;
  projectTitle: string;
  planReady: boolean;
  visible: boolean;
  addProjectRepo: Store["addProjectRepo"];
  fleetStartProject: Store["fleetStartProject"];
}

export function usePlanPublish(deps: PlanPublishDeps) {
  const {
    githubToken, publishRepos, injectionGateState, sections, planningTitle,
    activeProjectName, planFleet, effectiveProjectId, activeProjectId, activeProjectNumber,
    planFeatures, planDependencies, depManifest, repoPublic, reposPublic,
    projectTitle, planReady, visible, addProjectRepo, fleetStartProject,
  } = deps;

  const [triaging, setTriaging] = useState(false);
  const [triageError, setTriageError] = useState<string | null>(null); // launch-failure surfacing (#551)
  const [triageNote, setTriageNote] = useState<string | null>(null);   // progress-gated relaunch summary (#1004)
  // GitHub→plan.db recovery (#plan-db): how many planner-published issues GitHub holds when the
  // local plan.db is empty (machine switch / data loss), and whether a recovery is in flight.
  const [recoverable, setRecoverable] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const [publishPhase, setPublishPhase] = useState<PublishPhase>("idle");
  // Live status of each GitHub object, keyed by the ids in buildGhStructure.
  const [ghStatus, setGhStatus] = useState<GhStatusMap>({});
  // Confirm + clear stale warden quarantines before a triage relaunch (a denied command from a prior
  // run otherwise persists and immediately re-pauses the relaunched worker). `quarantineDialog` is the
  // self-rendering modal node the JSX mounts.
  const { confirm, dialog: quarantineDialog } = useConfirmDialog();

  async function launchTriage() {
    const fleet = planFleet[effectiveProjectId];
    // Pre-flight gate (#444/#551) — mirror the button's gate so a programmatic / Enter-key
    // path can't launch against an unpublished or plan-incomplete project. (Restored: the
    // refactor had weakened this to a repos/fleet-only check.)
    if (!canLaunchTriage({
      published: !!activeProjectId,
      hasRepos: publishRepos.length > 0,
      hasFleet: !!fleet && fleet.streams.length > 0,
      busy: triaging,
      planReady,
    })) return;
    // A stale warden quarantine from a PRIOR run persists (in quarantinedPanes + the bsc-audit log)
    // and would immediately re-pause the relaunched worker. On triage: show the user WHY each worker
    // was quarantined, then clear those flags and stamp a warden "since" floor so the relaunch is clean.
    const projQuarantines = Object.entries(useAppStore.getState().quarantinedPanes)
      .filter(([p]) => p.startsWith(`${effectiveProjectId}:`));
    if (projQuarantines.length > 0) {
      const reasons = projQuarantines.map(([, info]) => `${info.streamId} (${info.summary})`).join("; ");
      const ok = await confirm({
        title: projQuarantines.length === 1 ? "Clear worker quarantine?" : `Clear ${projQuarantines.length} worker quarantines?`,
        message: `${projQuarantines.length === 1 ? "A worker was" : `${projQuarantines.length} workers were`} `
          + `quarantined and paused — ${reasons}. Relaunching clears `
          + `${projQuarantines.length === 1 ? "it and resumes the worker" : "them and resumes the workers"}.`,
        confirmLabel: "Clear & relaunch",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
    }
    // Always stamp the warden floor for the project's panes on relaunch (even with nothing currently
    // flagged) so a stale denied command that hasn't tripped the warden yet also can't re-pause.
    {
      const relaunchPanes = (fleet?.streams ?? []).map((st) => `${effectiveProjectId}:${st.id}`);
      useAppStore.getState().clearProjectQuarantine(effectiveProjectId, relaunchPanes, Date.now());
    }
    setTriageError(null);
    setTriageNote(null);
    setTriaging(true);
    try {
      // Materialize the project hub on disk (#2997 C, epic #2993): planning ran in an ephemeral
      // per-project workspace, so this creates projects/<key>/ and moves the planner's authored files
      // in — BEFORE any director/worker cwd (the hub dir or a worktree beneath it) resolves to it.
      // Idempotent: an already-materialized hub or a re-launch is a no-op. Fail-CLOSED — without the
      // hub the director + worktree cwds don't exist, so surface the failure and abort the launch
      // rather than dropping the fleet into a missing directory.
      try {
        await invoke("materialize_hub", { projectKey: effectiveProjectId });
      } catch (e) {
        setTriageError(`launch failed — could not materialize the project hub: ${String(e)}`);
        return;
      }
      // #1988: when the sandbox is on AND the fleet runs on the model-agnostic bsc-agent harness (the
      // only runtime baked into the sealed distro), the whole fleet launches INSIDE the WSL2 cage —
      // the hub is relocated to the distro's ext4, repos are cloned + worktrees created in-distro, and
      // every pane spawns via `wsl -d <distro>`. Otherwise it's the normal host launch.
      const store0 = useAppStore.getState();
      const sandbox = store0.sandboxConsoles === true
        && effectiveHarness(store0.llmProvider, store0.fleetHarness ?? "claude") === "bsc-agent";
      const SANDBOX_DISTRO = "bsc-agent-sandbox";
      // Host clones seed the on-disk repo list the UI reads; skip them for a sandboxed launch (repos
      // are git-cloned in-distro by ensure_sandbox_worktree — nothing lands on the Windows host).
      if (!sandbox) await Promise.all(publishRepos.map(fullName =>
        invoke<string>("clone_repo", { project: effectiveProjectId, fullName })
          .then(() => addProjectRepo(activeProjectId ?? effectiveProjectId, fullName))
          .catch(e => console.error(`clone ${fullName} failed:`, e)),
      ));
      // Each worker auto-runs under its ROLE's default profile at launch (worker → Autonomous,
      // director → Read-only review) — no per-stream profile to materialize here anymore.
      const fullPlan = useAppStore.getState().planFleet[effectiveProjectId] ?? fleet;
      // Progress-gated relaunch (#1004): read each issue's status from plan.db and DON'T restart a
      // worker whose issues are all complete/verified — it already finished. Prune those streams (their
      // worktrees/branches persist untouched); launch only the streams with outstanding work, plus the
      // director if enabled. On a first launch nothing is done, so every stream stays active.
      const dbIssues = await bscJson<PlanIssue[]>(effectiveProjectId, ["plan", "list", "--full", "--json"], []);
      // #1957: completed workers no longer skip — they relaunch INTO maintenance (alive + ready for the
      // director to dispatch new lane work), so launch BOTH active and maintenance streams. The
      // maintenance set drives a maintenance scope banner (buildWorkerScope) so they stand by, not rebuild.
      // #4103: plan.db's issue rows can be empty for a fleet assembled outside a full planner run, in
      // which case `doneIssueRefs` is empty and NO stream ever prunes as complete. GitHub's closed set
      // is the other evidence source; either one calling a ref done makes it done.
      const closedRefs = await resolveClosedRefs(fullPlan.streams);
      const done = new Set([...doneIssueRefs(dbIssues), ...closedRefs]);
      const { active, maintenance } = pruneCompletedStreams(fullPlan.streams, done);
      const maintenanceIds = new Set(maintenance.map(s => s.id));
      // #2611: a stream with no resolvable repo stays VISIBLE in the plan but can't spawn a worktree —
      // skip it here (rather than aborting the fail-closed launch on a broken ensure_worktree) and
      // surface which streams still need a repo assigned, so the gap is seen, not swallowed.
      // #2615: a stream can reach launch with an empty `issues[]` even though issues name it as their
      // owning `stream` — enrich each stream's issue list from the plan.db issues so a worker launches
      // with its concrete task list (feeding BOTH the scope below and the kickoff via fleetStartProject),
      // not the "(none yet — ask the director)" placeholder. A stream that already lists issues is kept.
      const launchable = withDerivedStreamIssues([...active, ...maintenance].filter(st => st.repo), dbIssues);
      const noRepo = [...active, ...maintenance].filter(st => !st.repo);
      // Team-driven fleet (#3101/#3103): a project's TEAM contributes its ROLE-ACTOR sessions (curator,
      // documentor, reviewer, tester, juror, issuer) — one per team position bound to such a persona,
      // deduped vs the planner's own streams. They run at the project HUB (no repo → no worktree; the
      // `fleetStartProject` repo-less branch routes them there), so they compose in AFTER `launchable`
      // and are deliberately NOT part of the worktree-creation loop below.
      const teamStore = useAppStore.getState();
      const projectTeam = teamStore.blueprints.find(b => b.id === teamStore.projectBlueprintId[effectiveProjectId])?.team;
      const roleStreams = teamRoleStreams(projectTeam, teamStore.personas, fullPlan.streams);
      const launchPlan = { ...fullPlan, streams: [...launchable, ...roleStreams] };
      if (launchPlan.streams.length === 0 && !launchPlan.director.enabled) {
        setTriageError(noRepo.length > 0
          ? `No workers to launch — ${noRepo.length} stream${noRepo.length === 1 ? "" : "s"} (${noRepo.map(s => s.id).join(", ")}) need a repo assigned.`
          : "No workers to launch.");
        return;
      }
      const launchNotes: string[] = [];
      if (noRepo.length > 0) {
        launchNotes.push(`${noRepo.length} stream${noRepo.length === 1 ? "" : "s"} `
          + `(${noRepo.map(s => s.id).join(", ")}) skipped — no repo assigned`);
      }
      if (maintenance.length > 0) {
        launchNotes.push(`${maintenance.length} completed worker${maintenance.length === 1 ? "" : "s"} `
          + `(${maintenance.map(s => s.id).join(", ")}) relaunching into maintenance`
          + (active.length > 0 ? `; ${active.length} active` : ""));
      }
      if (launchNotes.length > 0) setTriageNote(launchNotes.join(". ") + ".");
      // The project's {kit, theme} pairing (#2489): plan.db's `ui` blob (the planner's per-project
      // record, `bsc plan ui set` in the Test UI stage) with the project blueprint's pin filling
      // whatever it doesn't set — inlined into every worker's scope as the UI-palette lock block
      // (token layer read-only; palette = the swappable theme.css).
      const uiBlob = await bscJson<{ kit?: { id?: string; version?: string } | null; themeId?: string } | null>(
        effectiveProjectId, ["plan", "ui", "get", "--json"], null);
      const storeUi = useAppStore.getState();
      const uiPairing = toWorkerUiPairing(
        uiBlob, storeUi.blueprints.find(b => b.id === storeUi.projectBlueprintId[effectiveProjectId])?.uiKit);
      // Create each worker's git worktree FAIL-CLOSED (#551/#359): if any can't be created,
      // abort the launch so no agent starts in a fallback dir. (Restored: the refactor had
      // weakened this to a non-fatal .catch that let the launch continue.)
      // Only the repo'd WORKER streams get a worktree — the team's hub role-actors (repo-less) are
      // excluded (they run at the hub, no isolated tree). `launchable` is exactly those worker streams.
      const worktreeResults = await Promise.all(launchable.map(st => {
        // Seed each worktree's CLAUDE.local.md with the worker's SCOPE (owns/issues/deps) plus its
        // repo's LOCKED dependency manifest (#1111), not the full plan — the worktree lives outside
        // the hub so the planner spec is no longer an ancestor (#844). In-distro when sandboxed
        // (ensure_sandbox_worktree clones the repo + adds the worktree on the distro's ext4, #1988).
        const scopeMd = buildWorkerScope(st, depsForRepo(planDependencies, st.repo), maintenanceIds.has(st.id), uiPairing);
        const call = sandbox
          ? invoke<string>("ensure_sandbox_worktree", { projectKey: effectiveProjectId, repo: st.repo, agentId: st.id, scopeMd, token: githubToken })
          : invoke<string>("ensure_worktree", { projectKey: effectiveProjectId, repo: st.repo, agentId: st.id, scopeMd });
        return call
          .then(path => ({ id: st.id, path, err: null as string | null }))
          .catch(e => ({ id: st.id, path: null as string | null, err: String(e) }));
      }));
      const failed = worktreeResults.filter(r => r.err || !r.path);
      if (failed.length > 0) {
        setTriageError(`launch failed — ${failed[0].id}: ${failed[0].err ?? "empty path"}`);
        return;
      }
      // Carry the authoritative absolute paths into fleetStartProject (#905) so each pane's
      // cwd comes from the Rust backend, not the async-loaded `bscBaseDir` mirror (which, when
      // empty/malformed, silently drops every session at the user's home dir). Workers use the
      // worktree path ensure_worktree just returned; the director uses the hub dir.
      const worktreePaths: Record<string, string> = {};
      for (const r of worktreeResults) if (r.path) worktreePaths[r.id] = r.path;
      // The director's cwd is the hub. Sandboxed → relocate the host hub onto the distro's ext4 and use
      // its distro-native path (setup_sandbox_hub); otherwise the on-host hub dir (#905).
      const hubPath = sandbox
        ? await safeInvoke<string>("setup_sandbox_hub", { key: effectiveProjectId }, "")
        : await safeInvoke<string>("project_dir_path", { projectKey: effectiveProjectId }, "");
      // Give the director its standing protocol at the hub (#375) so it gets the bsc-fleet
      // roster instruction + answers worker questions (the refactor dropped this call; #734).
      if (launchPlan.director.enabled) {
        await safeInvoke("ensure_director_protocol", { projectKey: effectiveProjectId }, undefined,
          e => console.error("director protocol failed:", e));
      }
      const roster = fleetStartProject(projectTitle, launchPlan, effectiveProjectId, { hubPath, worktreePaths, wslDistro: sandbox ? SANDBOX_DISTRO : undefined });
      publishFleetRoster(effectiveProjectId, roster); // #734: hub fleet.roster.tsv for bsc-fleet
    } catch (e) {
      console.error("fleet launch failed:", e);
    } finally {
      setTriaging(false);
    }
  }

  /** The LOCAL commit (#3280) — materialize the plan's issues into plan.db and mark the project active,
   *  with NO GitHub round-trip. This is what lets the fleet launch offline: `activeProjectId` set to the
   *  local project key flips `published` true (`canLaunchTriage`) and works as a key everywhere; a later
   *  publish upgrades it to the GitHub node id over the SAME plan.db rows (upsert-by-ref, no dupes).
   *  Shares publish's injection gate — never promote unreviewed markers to the fleet. */
  async function commitLocal() {
    if (!injectionGateState.cleared) {
      const n = injectionGateState.findings.length;
      setTriageError(injectionGateState.mode === "blocked"
        ? `Commit blocked: ${n} possible prompt-injection marker${n !== 1 ? "s" : ""} in the plan must be removed (hard-block is on in Settings).`
        : `Review the ${n} possible prompt-injection marker${n !== 1 ? "s" : ""} flagged in the plan, then acknowledge them before committing.`);
      return;
    }
    setTriageError(null);
    const featuresContent = sections.find(s => s.k === "features")?.content ?? "";
    await materializeIssues(featuresContent, { upsertIssue: (iss) => bscWrite(effectiveProjectId, ["plan", "add"], iss) });
    const goalContent  = sections.find(s => s.k === "goal")?.content ?? "";
    const projectTitle = deriveProjectTitle(planningTitle, goalContent, activeProjectName);
    // The local key IS activeProjectId here (no GitHub number) — publish later overwrites it with the
    // ProjectV2 node id. Reopening from the board derives the hub key from the name, so nothing bridges.
    useAppStore.getState().setActiveProjectMeta(effectiveProjectId, projectTitle, publishRepos[0] ?? "", 0, publishRepos);
  }

  async function handlePublish() {
    // #3280 local-first: with no GitHub token, "publish" commits the plan LOCALLY (plan.db) instead of
    // erroring — the fleet can then launch offline. Publishing to GitHub stays the optional path when
    // connected. (publishBlockReason's no-token case is now unreachable from here; the no-repo case
    // below still fires when connected.)
    if (!githubToken) { await commitLocal(); return; }
    // Don't fail silently (#969): surface WHY publish can't proceed, so the user isn't left thinking
    // they published when nothing happened (which then leaves the fleet-launch button locked with no
    // explanation). The common case is a blueprint with no Repos stage ⇒ no repo ever linked.
    const blocked = publishBlockReason({ hasToken: !!githubToken, repoCount: publishRepos.length });
    if (blocked) { setTriageError(blocked); return; }
    // #1107: never promote a plan with unreviewed / hard-blocked injection markers to the fleet.
    if (!injectionGateState.cleared) {
      const n = injectionGateState.findings.length;
      setTriageError(injectionGateState.mode === "blocked"
        ? `Publish blocked: ${n} possible prompt-injection marker${n !== 1 ? "s" : ""} in the plan must be removed (hard-block is on in Settings).`
        : `Review the ${n} possible prompt-injection marker${n !== 1 ? "s" : ""} flagged in the plan, then acknowledge them before publishing.`);
      return;
    }
    setTriageError(null);
    const token = githubToken;

    const repos        = publishRepos;
    const goalContent  = sections.find(s => s.k === "goal")?.content ?? "";
    const projectTitle = deriveProjectTitle(planningTitle, goalContent, activeProjectName);
    const projectDesc  = goalContent.split(/\n/)[0].slice(0, 350);
    const fleet        = planFleet[effectiveProjectId];
    const streams      = fleet?.streams ?? [];

    // Seed every node as "planned" so the card shows the full structure upfront.
    const status = seedPublishStatus({ repos, streams });
    setGhStatus({ ...status });
    setPublishPhase("running");

    let anyError = false;
    const upd: Upd = (id, patch) => {
      status[id] = { ...(status[id] ?? { status: "planned" }), ...patch };
      if (patch.status === "error") anyError = true;
      setGhStatus({ ...status });
    };

    // The GitHub transport — the same closures the steps consume (injected so they're testable).
    const api: GhApi = {
      gql: (query, variables) => invoke<Record<string, unknown>>("github_graphql", { token, query, variables }),
      rest: <T,>(path: string) => invoke<T>("github_request", { token, path }),
      post: <T,>(path: string, body: unknown) => invoke<T>("github_post", { token, path, body }),
      put: (path, body) => invoke("github_put", { token, path, body }),
      patch: (path, body) => invoke("github_patch", { token, path, body }),
    };

    try {
      // 1. Repositories — verify/create.
      const { repoNodeIds, viewerLogin } = await publishRepositories(api, upd, {
        repos, projectDesc, repoPublic, reposPublic, effectiveProjectId,
      });

      // 1b. Repo presentation — description/topics/README/community files + locked dep manifests.
      await scaffoldRepositories(api, upd, {
        repos, projectDesc, projectTitle, goalContent,
        stackText: sections.find(s => s.k === "stack")?.content ?? "",
        scopeText: sections.find(s => s.k === "scope")?.content ?? "",
        archText:  sections.find(s => s.k === "architecture")?.content ?? "",
        features: planFeatures.map(f => ({ name: f.name, behavior: f.behavior })),
        planDependencies, registries: depManifest.registries,
      });

      // 2. Project board — reuse or create; the store writes for a new board happen here in the hook.
      const board = await ensureProjectBoard(api, upd, {
        activeProjectId, activeProjectNumber, repos, viewerLogin, projectTitle, repoNodeIds,
      });
      const projectId = board.projectId;
      if (board.created) {
        const pv = board.created;
        const store = useAppStore.getState();
        // Reflect in the store so the projects list + future syncs treat it as existing.
        store.setActiveProjectMeta(pv.id, projectTitle, repos[0] ?? "", pv.number, repos);
        // No node-id → key alias write anymore (#2409): reopening from the board DERIVES the hub
        // key from the project's name (`projectSlug(title)`), so publish records nothing to bridge.
        // Mark the hub published in place (#922) — the hub never moves, so --continue history survives.
        fireInvoke("mark_published", { projectKey: effectiveProjectId }, (e) => console.warn("mark_published failed (Projects page reconciles it):", e));
        // Drop the store's draft entry so the project can't linger as a ghost draft card, and mirror
        // that removal into the durable projects DB (#2995) so the published project doesn't re-surface
        // as a draft from the DB union. Fire-and-forget; degrades silently.
        store.removeDraftProject(effectiveProjectId);
        void removeDbProject(effectiveProjectId);
      }

      // 3. Issues — features → issues, on the board, assigned, sub-issues nested (no milestones, #1912).
      await createIssues(api, upd, {
        repos, featuresContent: sections.find(s => s.k === "features")?.content ?? "",
        projectId, streams, viewerLogin,
      }, {
        upsertIssue: (iss) => bscWrite(effectiveProjectId, ["plan", "add"], iss),
      });

      // 4. Stream labels.
      await applyStreamLabels(api, upd, { streams });

      setPublishPhase(anyError ? "error" : "done");
    } catch (e) {
      console.error("publish failed", e);
      setPublishPhase("error");
    }
  }

  // GitHub → plan.db recovery (#plan-db). The mirror of handlePublish: pull each repo's
  // planner-published issues back into the plan store so a lost or machine-switched plan.db
  // rehydrates from the durable GitHub copy. Paginates issues (state=all), drops PRs, and upserts
  // each reconstructed PlanIssue (ref/dependsOn from the hidden marker, stream from the label,
  // status from open/closed). The 2s section poll reflects the DB afterward.
  async function handleRecover() {
    if (!githubToken || publishRepos.length === 0 || recovering) return;
    setRecovering(true);
    setTriageError(null);
    const token = githubToken;
    const rest = <T,>(path: string) => invoke<T>("github_request", { token, path });
    try {
      let total = 0;
      for (const repo of publishRepos) {
        const rows: GitHubIssueLike[] = [];
        for (let page = 1; page <= 20; page++) {
          const batch = await rest<GitHubIssueLike[]>(`repos/${repo}/issues?state=all&per_page=100&page=${page}`)
            .catch(() => [] as GitHubIssueLike[]);
          if (!batch || batch.length === 0) break;
          rows.push(...batch);
          if (batch.length < 100) break; // last page
        }
        for (const iss of recoverIssues(rows, repo)) {
          await bscWrite(effectiveProjectId, ["plan", "add"], iss);
          total++;
        }
      }
      setRecoverable(0);
      if (total === 0) setTriageError("recover — GitHub had no planner-published issues for these repos");
    } catch (e) {
      setTriageError(`recover failed — ${String(e)}`);
    } finally {
      setRecovering(false);
    }
  }

  // Offer recovery when the local plan.db is empty but GitHub holds planner-published issues (the
  // machine-switch / data-loss case). Probes the first repo for issues carrying the ref marker and
  // surfaces the banner; the recovery itself stays user-initiated.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!visible || !githubToken || publishRepos.length === 0) { setRecoverable(0); return; }
      const dbIssues = await bscJson<PlanIssue[]>(effectiveProjectId, ["plan", "list", "--full", "--json"], []);
      if (cancelled) return;
      if ((dbIssues?.length ?? 0) > 0) { setRecoverable(0); return; } // db already populated — nothing to recover
      const rows = await safeInvoke<GitHubIssueLike[]>("github_request", {
        token: githubToken, path: `repos/${publishRepos[0]}/issues?state=all&per_page=100`,
      }, []);
      if (cancelled) return;
      // Count only planner-published issues — those with a ref marker (a recovered ref isn't "#<n>").
      setRecoverable(recoverIssues(rows ?? [], publishRepos[0]).filter((i) => !i.ref.startsWith("#")).length);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, githubToken, publishRepos.join(","), effectiveProjectId]);

  return { handlePublish, launchTriage, handleRecover, triaging, triageError, triageNote, recoverable, recovering, publishPhase, setPublishPhase, ghStatus, quarantineDialog };
}
