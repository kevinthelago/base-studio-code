// usePlanPublish (#1490) — the publish → GitHub + triage-launch + GitHub→plan.db recovery cluster,
// extracted verbatim from Planning.tsx. Owns the triage/publish/recovery state (no render loop —
// just callbacks + a recovery probe effect); takes the plan data it reads as a params object so the
// bodies move unchanged. Returns the callbacks + the state the JSX consumes.

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke, fireInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import { useConfirmDialog } from "@/shared/ui/overlay/promptDialog";
import type { Section } from "../github/ghStructure";
import { type GhStatusMap } from "./GitHubStructureCard";
import { deriveProjectTitle } from "./projectTitle";
import { parseFeaturesFile } from "../issues/featureList";
import { parseDependencyManifest, depsForRepo } from "../issues/dependencies";
import { buildWorkerScope } from "../fleet/workerScope";
import { type PlanIssue } from "../issues/planIssues";
import { pruneCompletedStreams, doneIssueRefs } from "../fleet/streamCompletion";
import { recoverIssues, type GitHubIssueLike } from "../issues/recoverIssues";
import { publishFleetRoster } from "@/shared/lib/fleet/fleetRoster";
import { canLaunchTriage, publishBlockReason } from "@/features/github/lib/projectSync";
import { coerceBlueprint, blueprintToManifest } from "../blueprints/blueprintShare";
import { resolveBlueprintSkillPayloads } from "../blueprints/blueprintSkills";
import { publishGist } from "@/features/planner/lib/gist/gist";
import {
  type GhApi, type Upd, seedPublishStatus,
  publishRepositories, scaffoldRepositories, ensureProjectBoard, createIssues, applyStreamLabels,
} from "./publishSteps";

export type PublishPhase = "idle" | "running" | "done" | "error";

type Store = ReturnType<typeof useAppStore.getState>;

export interface PlanPublishDeps {
  isAuthoring: boolean;
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
  planAuthoredBlueprint: Store["planAuthoredBlueprint"];
  paneId: string;
  projectTitle: string;
  planReady: boolean;
  visible: boolean;
  addProjectRepo: Store["addProjectRepo"];
  fleetStartProject: Store["fleetStartProject"];
  importBlueprint: Store["importBlueprint"];
}

export function usePlanPublish(deps: PlanPublishDeps) {
  const {
    isAuthoring, githubToken, publishRepos, injectionGateState, sections, planningTitle,
    activeProjectName, planFleet, effectiveProjectId, activeProjectId, activeProjectNumber,
    planFeatures, planDependencies, depManifest, repoPublic, reposPublic, planAuthoredBlueprint,
    paneId, projectTitle, planReady, visible, addProjectRepo, fleetStartProject, importBlueprint,
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
      await Promise.all(publishRepos.map(fullName =>
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
      const dbIssues = await safeInvoke<PlanIssue[]>("plan_list_issues", { projectKey: effectiveProjectId }, []);
      // #1957: completed workers no longer skip — they relaunch INTO maintenance (alive + ready for the
      // director to dispatch new lane work), so launch BOTH active and maintenance streams. The
      // maintenance set drives a maintenance scope banner (buildWorkerScope) so they stand by, not rebuild.
      const { active, maintenance } = pruneCompletedStreams(fullPlan.streams, doneIssueRefs(dbIssues));
      const maintenanceIds = new Set(maintenance.map(s => s.id));
      const launchPlan = { ...fullPlan, streams: [...active, ...maintenance] };
      if (launchPlan.streams.length === 0 && !launchPlan.director.enabled) {
        setTriageError("No workers to launch.");
        return;
      }
      if (maintenance.length > 0) {
        setTriageNote(`${maintenance.length} completed worker${maintenance.length === 1 ? "" : "s"} `
          + `(${maintenance.map(s => s.id).join(", ")}) relaunching into maintenance`
          + (active.length > 0 ? `; ${active.length} active.` : "."));
      }
      // Create each worker's git worktree FAIL-CLOSED (#551/#359): if any can't be created,
      // abort the launch so no agent starts in a fallback dir. (Restored: the refactor had
      // weakened this to a non-fatal .catch that let the launch continue.)
      const worktreeResults = await Promise.all(launchPlan.streams.map(st =>
        // Seed each worktree's CLAUDE.local.md with the worker's SCOPE (owns/issues/deps) plus its
        // repo's LOCKED dependency manifest (#1111), not the full plan — the worktree lives outside
        // the hub so the planner spec is no longer an ancestor (#844).
        invoke<string>("ensure_worktree", { projectKey: effectiveProjectId, repo: st.repo, agentId: st.id, scopeMd: buildWorkerScope(st, depsForRepo(planDependencies, st.repo), maintenanceIds.has(st.id)) })
          .then(path => ({ id: st.id, path, err: null as string | null }))
          .catch(e => ({ id: st.id, path: null as string | null, err: String(e) })),
      ));
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
      const hubPath = await safeInvoke<string>("project_dir_path", { projectKey: effectiveProjectId }, "");
      // Give the director its standing protocol at the hub (#375) so it gets the bsc-fleet
      // roster instruction + answers worker questions (the refactor dropped this call; #734).
      if (launchPlan.director.enabled) {
        await safeInvoke("ensure_director_protocol", { projectKey: effectiveProjectId }, undefined,
          e => console.error("director protocol failed:", e));
      }
      const roster = fleetStartProject(projectTitle, launchPlan, effectiveProjectId, { hubPath, worktreePaths });
      publishFleetRoster(effectiveProjectId, roster); // #734: hub fleet.roster.tsv for bsc-fleet
    } catch (e) {
      console.error("fleet launch failed:", e);
    } finally {
      setTriaging(false);
    }
  }

  // Publish an AUTHORING project's deliverable (#923): land the designed blueprint in the library,
  // then ship it to a gist per the chosen visibility — "local" stays library-only, "private-gist" is
  // secret, "catalog" is public. No repos/board/milestones/issues/fleet.
  async function publishAuthoredBlueprint() {
    const bp = planAuthoredBlueprint[effectiveProjectId];
    const valid = bp ? coerceBlueprint(bp) : null;
    if (!valid) { setPublishPhase("error"); return; }
    const visibility = valid.visibility ?? "private-gist";
    if (visibility !== "local" && !githubToken) { setPublishPhase("error"); return; }
    setGhStatus({ blueprint: { status: "running" } });
    setPublishPhase("running");
    try {
      const store = useAppStore.getState();
      // Land it in the local library so it's editable + re-publishable, and record which blueprint
      // seeded this project so re-opening resolves to it.
      const newId = importBlueprint(valid);
      store.setProjectBlueprintId(effectiveProjectId, newId);
      if (visibility === "local") {
        setGhStatus({ blueprint: { status: "created", detail: `${valid.name} · saved to library` } });
        setPublishPhase("done");
        fireInvoke("pty_write", { paneId, data: `[Blueprint "${valid.name}" saved to your local library.]\r` }, console.error);
        return;
      }
      // Bundle attached skill/KB content so the share is self-contained; MCP stays by reference.
      const bundled = resolveBlueprintSkillPayloads(valid, store.skills);
      const res = await publishGist(githubToken, blueprintToManifest(valid, bundled), { public: visibility === "catalog" });
      setGhStatus({ blueprint: { status: "created", detail: valid.name, url: res.htmlUrl } });
      setPublishPhase("done");
      const kind = visibility === "catalog" ? "public" : "secret";
      fireInvoke("pty_write", { paneId, data: `[Blueprint published to a ${kind} gist: ${res.htmlUrl}]\r` }, console.error);
    } catch (e) {
      setGhStatus({ blueprint: { status: "error", detail: String(e) } });
      setPublishPhase("error");
    }
  }

  async function handlePublish() {
    if (isAuthoring) { await publishAuthoredBlueprint(); return; }
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
        // Stable-key bridge: map the new board's node id → this project's folder key, so opening it
        // from the board later resolves to the SAME on-disk hub instead of keying fresh state.
        store.setProjectKeyAlias(pv.id, effectiveProjectId);
        // Mark the hub published in place (#922) — the hub never moves, so --continue history survives.
        fireInvoke("mark_published", { projectKey: effectiveProjectId }, (e) => console.warn("mark_published failed (Projects page reconciles it):", e));
        // Drop the store's draft entry so the project can't linger as a ghost draft card.
        store.removeDraftProject(effectiveProjectId);
      }

      // 3. Issues — features → issues, on the board, assigned, sub-issues nested (no milestones, #1912).
      await createIssues(api, upd, {
        repos, featuresContent: sections.find(s => s.k === "features")?.content ?? "",
        projectId, streams, viewerLogin,
      }, {
        upsertIssue: (iss) => invoke("plan_upsert_issue", { projectKey: effectiveProjectId, issue: iss })
          .then(() => {}).catch((e) => { console.warn(`plan_upsert_issue ${iss.ref}: ${e}`); }),
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
          await safeInvoke("plan_upsert_issue", { projectKey: effectiveProjectId, issue: iss }, undefined);
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
      const dbIssues = await safeInvoke<PlanIssue[]>("plan_list_issues", { projectKey: effectiveProjectId }, []);
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
