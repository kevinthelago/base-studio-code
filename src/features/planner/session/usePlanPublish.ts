// usePlanPublish (#1490) — the publish → GitHub + triage-launch + GitHub→plan.db recovery cluster,
// extracted verbatim from Planning.tsx. Owns the triage/publish/recovery state (no render loop —
// just callbacks + a recovery probe effect); takes the plan data it reads as a params object so the
// bodies move unchanged. Returns the callbacks + the state the JSX consumes.

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { resolveRepoPublic } from "@/store/slices/plan";
import { parsePhases } from "../github/ghStructure";
import type { Section } from "../github/ghStructure";
import { type GhStatusMap, type GhItemState } from "./GitHubStructureCard";
import { parseFeaturesFile, featuresToPlanIssues } from "../issues/featureList";
import { parseDependencyManifest, depsForRepo, mergeIntoPackageJson, mergeIntoCargoToml, buildNpmrc, buildCargoConfig } from "../issues/dependencies";
import { buildWorkerScope } from "../fleet/workerScope";
import { resolveIssueAssignee } from "../fleet/fleetAssignee";
import { deriveTopics, buildReadme, communityFiles, type ScaffoldFile } from "../lib/repoScaffold";
import { renderIssueBody, resolvePhaseIndex, subIssueLinks, type PlanIssue } from "../issues/planIssues";
import { pruneCompletedStreams, doneIssueRefs } from "../fleet/streamCompletion";
import { recoverIssues, type GitHubIssueLike } from "../issues/recoverIssues";
import { publishFleetRoster } from "@/shared/lib/fleet/fleetRoster";
import { canLaunchTriage, publishBlockReason } from "@/features/github/lib/projectSync";
import { coerceBlueprint, blueprintToManifest } from "../blueprints/blueprintShare";
import { resolveBlueprintSkillPayloads } from "../blueprints/blueprintSkills";
import { publishGist } from "@/features/planner/lib/gist/gist";
import { BSC_ISSUE_LABEL, BSC_ISSUE_LABEL_COLOR, withProvenanceLabel } from "@/features/github/lib/issueProvenance";

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
    setTriageError(null);
    setTriageNote(null);
    setTriaging(true);
    try {
      await Promise.all(publishRepos.map(fullName =>
        invoke<string>("clone_repo", { project: effectiveProjectId, fullName })
          .then(() => addProjectRepo(activeProjectId ?? effectiveProjectId, fullName))
          .catch(e => console.error(`clone ${fullName} failed:`, e)),
      ));
      // Materialize any unassigned / dangling-reference agent profiles before
      // launch so each worker gets its least-privilege profile (#358), then read
      // the fleet back with the now-assigned profile ids.
      useAppStore.getState().generateFleetProfiles(effectiveProjectId);
      const fullPlan = useAppStore.getState().planFleet[effectiveProjectId] ?? fleet;
      // Progress-gated relaunch (#1004): read each issue's status from plan.db and DON'T restart a
      // worker whose issues are all complete/verified — it already finished. Prune those streams (their
      // worktrees/branches persist untouched); launch only the streams with outstanding work, plus the
      // director if enabled. On a first launch nothing is done, so every stream stays active.
      const dbIssues = await invoke<PlanIssue[]>("plan_list_issues", { projectKey: effectiveProjectId })
        .catch(() => [] as PlanIssue[]);
      const { active, skipped } = pruneCompletedStreams(fullPlan.streams, doneIssueRefs(dbIssues));
      const launchPlan = { ...fullPlan, streams: active };
      if (active.length === 0 && !launchPlan.director.enabled) {
        setTriageError("Every worker's issues are already complete — nothing to relaunch.");
        return;
      }
      if (skipped.length > 0) {
        setTriageNote(`Skipped ${skipped.length} completed worker${skipped.length === 1 ? "" : "s"} `
          + `(${skipped.map(s => s.id).join(", ")}) — relaunching ${active.length}.`);
      }
      // Create each worker's git worktree FAIL-CLOSED (#551/#359): if any can't be created,
      // abort the launch so no agent starts in a fallback dir. (Restored: the refactor had
      // weakened this to a non-fatal .catch that let the launch continue.)
      const worktreeResults = await Promise.all(launchPlan.streams.map(st =>
        // Seed each worktree's CLAUDE.local.md with the worker's SCOPE (owns/issues/deps) plus its
        // repo's LOCKED dependency manifest (#1111), not the full plan — the worktree lives outside
        // the hub so the planner spec is no longer an ancestor (#844).
        invoke<string>("ensure_worktree", { projectKey: effectiveProjectId, repo: st.repo, agentId: st.id, scopeMd: buildWorkerScope(st, depsForRepo(planDependencies, st.repo)) })
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
      const hubPath = await invoke<string>("project_dir_path", { projectKey: effectiveProjectId }).catch(() => "");
      // Give the director its standing protocol at the hub (#375) so it gets the bsc-fleet
      // roster instruction + answers worker questions (the refactor dropped this call; #734).
      if (launchPlan.director.enabled) {
        await invoke("ensure_director_protocol", { projectKey: effectiveProjectId })
          .catch(e => console.error("director protocol failed:", e));
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
        invoke("pty_write", { paneId, data: `[Blueprint "${valid.name}" saved to your local library.]\r` }).catch(console.error);
        return;
      }
      // Bundle attached skill/KB content so the share is self-contained; MCP stays by reference.
      const bundled = resolveBlueprintSkillPayloads(valid, store.skills);
      const res = await publishGist(githubToken, blueprintToManifest(valid, bundled), { public: visibility === "catalog" });
      setGhStatus({ blueprint: { status: "created", detail: valid.name, url: res.htmlUrl } });
      setPublishPhase("done");
      const kind = visibility === "catalog" ? "public" : "secret";
      invoke("pty_write", { paneId, data: `[Blueprint published to a ${kind} gist: ${res.htmlUrl}]\r` }).catch(console.error);
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

    const repos       = publishRepos;
    const noRepo      = repos.length === 0;
    const phases      = parsePhases(sections.find(s => s.k === "phases")?.content ?? "");
    const goalContent = sections.find(s => s.k === "goal")?.content ?? "";
    const projectTitle = planningTitle || goalContent.split(/[.!?\n]/)[0].trim() || activeProjectName || "New project";
    const projectDesc  = goalContent.split(/\n/)[0].slice(0, 350);
    const fleet        = planFleet[effectiveProjectId];

    // Seed every node as "planned" so the card shows the full structure upfront.
    // Issues are namespaced per repo so each repo tracks its own phase issues.
    const status: GhStatusMap = {};
    status["project"] = { status: "planned" };
    phases.forEach((_, i) => { status[`ms:${i}`] = { status: "planned" }; });
    repos.forEach(r => {
      status[`repo:${r}`] = { status: "planned" };
      phases.forEach((_, i) => { status[`issue:${r}:${i}`] = { status: "planned" }; });
    });
    (fleet?.streams ?? []).forEach(st => { status[`stream:${st.id}`] = { status: "planned" }; });
    setGhStatus({ ...status });
    setPublishPhase("running");

    let anyError = false;
    const upd = (id: string, patch: Partial<GhItemState>) => {
      status[id] = { ...(status[id] ?? { status: "planned" }), ...patch };
      if (patch.status === "error") anyError = true;
      setGhStatus({ ...status });
    };

    const gql = (query: string, variables: unknown) =>
      invoke<Record<string, unknown>>("github_graphql", { token, query, variables });
    const rest = <T,>(path: string) => invoke<T>("github_request", { token, path });
    const post = <T,>(path: string, body: unknown) => invoke<T>("github_post", { token, path, body });
    const put = (path: string, body: unknown) => invoke("github_put", { token, path, body });
    const patch = (path: string, body: unknown) => invoke("github_patch", { token, path, body });

    try {
      // ── 1. Repositories — verify each exists; create if missing ───────────
      const repoNodeIds: Record<string, string> = {};
      let viewerLogin = "";
      try {
        const v = await gql(`{ viewer { login } }`, null) as { viewer?: { login?: string } };
        viewerLogin = v.viewer?.login ?? "";
      } catch { /* non-fatal: fall back to org repo path */ }

      for (const fullName of repos) {
        const id = `repo:${fullName}`;
        const [owner, name] = fullName.split("/");
        upd(id, { status: "running" });
        try {
          const existing = await rest<{ node_id: string; html_url: string }>(`repos/${fullName}`).catch(() => null);
          if (existing?.node_id) {
            repoNodeIds[fullName] = existing.node_id;
            upd(id, { status: "exists", detail: "on github", url: existing.html_url });
          } else {
            const path = owner.toLowerCase() === viewerLogin.toLowerCase() ? "user/repos" : `orgs/${owner}/repos`;
            const created = await post<{ node_id: string; html_url: string }>(path, {
              // Per-repo visibility (#1227): the repo's own toggle wins, else the project default,
              // else private. Existing repos are detected above and never re-created, so this
              // governs creation only.
              name, private: !resolveRepoPublic(repoPublic, reposPublic, effectiveProjectId, fullName), description: projectDesc,
            });
            repoNodeIds[fullName] = created.node_id;
            upd(id, { status: "created", detail: "created", url: created.html_url });
          }
        } catch (e) {
          upd(id, { status: "error", detail: String(e) });
        }
      }

      // ── 1b. Repo presentation (#848, #1114): the repo description (set on EVERY repo,
      //        created or pre-existing), topics from the stack, and a thorough README built
      //        from the plan (goal/scope/features/architecture) with CI/version badges, plus
      //        the standard community-health files. Files are created only when ABSENT (never
      //        clobber a hand-written one); a repo with no workflows simply omits CI badges;
      //        any failure is surfaced in the card detail, not fatal. ──
      {
        const stackText = sections.find(s => s.k === "stack")?.content ?? "";
        const scopeText = sections.find(s => s.k === "scope")?.content ?? "";
        const archText  = sections.find(s => s.k === "architecture")?.content ?? "";
        const readmeFeatures = planFeatures.map(f => ({ name: f.name, behavior: f.behavior }));
        const topics = deriveTopics(stackText);
        for (const fullName of repos) {
          const id = `scaffold:${fullName}`;
          upd(id, { status: "running" });
          try {
            // Always (re)apply the description — a create sets it, but a pre-existing repo never had it.
            let descOk = true;
            if (projectDesc) await patch(`repos/${fullName}`, { description: projectDesc }).catch(() => { descOk = false; });
            let topicsOk = true;
            if (topics.length) await put(`repos/${fullName}/topics`, { names: topics }).catch(() => { topicsOk = false; });
            // CI badges reference the repo's actual workflow files (graceful — none yet ⇒ none).
            const wfs = await rest<{ name: string }[]>(`repos/${fullName}/contents/.github/workflows`).catch(() => []);
            const workflows = (Array.isArray(wfs) ? wfs : []).map(w => w.name).filter(n => /\.ya?ml$/i.test(n));
            const files: ScaffoldFile[] = [
              { path: "README.md", content: buildReadme({
                fullName, description: projectDesc, goal: goalContent, scope: scopeText,
                architecture: archText, features: readmeFeatures, stackText, workflows,
              }) },
              ...communityFiles(projectTitle),
            ];
            let wrote = 0;
            for (const f of files) {
              const path = `repos/${fullName}/contents/${f.path}`;
              const exists = await rest<{ sha?: string }>(path).then(r => !!r?.sha).catch(() => false);
              if (exists) continue; // don't clobber an existing file
              const content = btoa(unescape(encodeURIComponent(f.content)));
              await put(path, { message: `docs: scaffold ${f.path}`, content }).catch(() => {});
              wrote++;
            }

            // Dependency manifests (#1111/#1127): seed the repo's package.json / Cargo.toml from the
            // locked manifest — and the registry config (.npmrc / .cargo/config.toml) for any private
            // SOURCE — so the fleet inherits identical, complete, fetchable deps from the base branch
            // and never adds its own. An ADDITIVE MERGE for the manifests — a pre-existing pinned
            // version always wins, so we read the current file, merge, and only write on a real change.
            let manifests = 0;
            const repoDeps = depsForRepo(planDependencies, fullName);
            if (repoDeps.length) {
              const shortRepo = fullName.split("/")[1] ?? fullName;
              const seedManifest = async (file: string, merge: (existing: string | null) => string | null) => {
                const path = `repos/${fullName}/contents/${file}`;
                const cur = await rest<{ sha?: string; content?: string }>(path).catch(() => null);
                const existing = cur?.content ? decodeURIComponent(escape(atob(cur.content.replace(/\s/g, "")))) : null;
                const merged = merge(existing);
                if (merged === null || merged === existing) return; // nothing to add / no change
                const content = btoa(unescape(encodeURIComponent(merged)));
                await put(path, { message: `chore: seed ${file} from the locked dependency manifest`, content, ...(cur?.sha ? { sha: cur.sha } : {}) }).catch(() => {});
                manifests++;
              };
              await seedManifest("package.json", (e) => mergeIntoPackageJson(e, shortRepo, repoDeps));
              await seedManifest("Cargo.toml", (e) => mergeIntoCargoToml(e, shortRepo, repoDeps));
              // Registry config for private sources — generated wholesale (not merged): create it only
              // when absent so a hand-tuned .npmrc / .cargo config is never clobbered.
              await seedManifest(".npmrc", (e) => (e === null ? buildNpmrc(depManifest.registries, repoDeps) : null));
              await seedManifest(".cargo/config.toml", (e) => (e === null ? buildCargoConfig(depManifest.registries, repoDeps) : null));
            }

            const bits = [
              projectDesc ? (descOk ? "description" : "description failed") : null,
              topics.length ? (topicsOk ? `${topics.length} topics` : "topics failed") : null,
              wrote ? `${wrote} file${wrote === 1 ? "" : "s"}` : null,
              manifests ? `${manifests} manifest${manifests === 1 ? "" : "s"}` : null,
            ].filter(Boolean);
            upd(id, (wrote || manifests)
              ? { status: "created", detail: bits.join(" · ") }
              : { status: "exists", detail: bits.length ? `${bits.join(" · ")} · files present` : "already scaffolded" });
          } catch (e) {
            upd(id, { status: "error", detail: String(e) });
          }
        }
      }

      // ── 2. Project board — reuse existing or create a Projects v2 board ───
      let projectId = activeProjectId;
      {
        const id = "project";
        upd(id, { status: "running" });
        try {
          if (projectId) {
            upd(id, { status: "exists", detail: activeProjectNumber ? `#${activeProjectNumber}` : "linked" });
          } else {
            const ownerLogin = repos[0]?.split("/")[0] || viewerLogin;
            if (!ownerLogin) throw new Error("no owner to create project under");
            const ownerData = await gql(
              `query($login:String!){ repositoryOwner(login:$login){ id } }`,
              { login: ownerLogin },
            ) as { repositoryOwner?: { id?: string } };
            const ownerId = ownerData.repositoryOwner?.id;
            if (!ownerId) throw new Error(`could not resolve owner '${ownerLogin}'`);
            const created = await gql(
              `mutation($ownerId:ID!,$title:String!){
                 createProjectV2(input:{ownerId:$ownerId,title:$title}){ projectV2 { id number url } }
               }`,
              { ownerId, title: projectTitle },
            ) as { createProjectV2?: { projectV2?: { id: string; number: number; url: string } } };
            const pv = created.createProjectV2?.projectV2;
            if (!pv) throw new Error("project not created");
            projectId = pv.id;
            // Reflect in the store so the projects list + future syncs treat it as existing.
            useAppStore.getState().setActiveProjectMeta(pv.id, projectTitle, repos[0] ?? "", pv.number, repos);
            // Stable-key bridge (#…): map the new board's node id → this project's folder key, so
            // opening it from the board later resolves to the SAME on-disk hub instead of keying
            // fresh state under the node id (the split that scattered repos/plan across two keys).
            useAppStore.getState().setProjectKeyAlias(pv.id, effectiveProjectId);
            // Mark the hub published (#922): write projects/<key>/.published in place. Unlike the
            // old promote-rename, this can't fail while the planner holds the hub as its cwd, and
            // the hub never moves — so Claude's --continue history survives.
            invoke("mark_published", { projectKey: effectiveProjectId }).catch((e) => console.warn("mark_published failed (Projects page reconciles it):", e));
            // Drop the store's draft entry so the project can't linger as a ghost draft card now
            // that it's published (the key-based dedup also excludes it, this keeps the map clean).
            useAppStore.getState().removeDraftProject(effectiveProjectId);
            upd(id, { status: "created", detail: `#${pv.number}`, url: pv.url });
          }
          // Link every repo to the board (idempotent server-side).
          for (const fullName of repos) {
            const repoNodeId = repoNodeIds[fullName];
            if (projectId && repoNodeId) {
              await gql(
                `mutation($p:ID!,$r:ID!){ linkProjectV2ToRepository(input:{projectId:$p,repositoryId:$r}){ repository { id } } }`,
                { p: projectId, r: repoNodeId },
              ).catch(() => { /* already linked — ignore */ });
            }
          }
        } catch (e) {
          upd(id, { status: "error", detail: String(e) });
        }
      }

      // ── 3. Milestones — one per phase in every repo ───────────────────────
      // Existing milestones per repo for idempotency; remember each repo's
      // milestone number per phase so that repo's issues can be assigned to it.
      // Existing milestones per repo (matched by the stable phase name). Fail
      // CLOSED: if a repo's fetch fails, record it and skip creating milestones
      // there rather than risk duplicates.
      const existingMs: Record<string, Map<string, number>> = {};
      const msFetchFailed = new Set<string>();
      if (!noRepo) {
        await Promise.all(repos.map(async r => {
          try {
            const list = await rest<{ title: string; number: number }[]>(
              `repos/${r}/milestones?state=all&per_page=100`,
            );
            existingMs[r] = new Map(list.map(m => [m.title, m.number]));
          } catch {
            msFetchFailed.add(r);
            existingMs[r] = new Map();
          }
        }));
      }
      // repo full_name → phase index → milestone number
      const msNumbers: Record<string, Record<number, number>> = {};
      for (let pi = 0; pi < phases.length; pi++) {
        const ph = phases[pi];
        const id = `ms:${pi}`;
        if (noRepo) { upd(id, { status: "skipped", detail: "no repo linked" }); continue; }
        upd(id, { status: "running" });
        try {
          let created = 0, existed = 0, unverified = 0;
          for (const r of repos) {
            if (!msNumbers[r]) msNumbers[r] = {};
            if (msFetchFailed.has(r)) { unverified++; continue; } // couldn't verify — skip
            const existingNum = existingMs[r]?.get(ph.name);
            if (existingNum !== undefined) {
              msNumbers[r][pi] = existingNum;
              existed++;
              continue;
            }
            const ms = await post<{ number: number }>(`repos/${r}/milestones`, {
              title: ph.name, description: ph.description ?? "",
            });
            msNumbers[r][pi] = ms.number;
            created++;
          }
          const suffix = repos.length > 1 ? ` · ${repos.length} repos` : "";
          if (created === 0 && existed === 0 && unverified > 0) {
            upd(id, { status: "error", detail: `couldn't verify existing milestones — skipped${suffix}` });
          } else {
            const parts: string[] = [];
            if (created)    parts.push(`${created} created`);
            if (existed)    parts.push(`${existed} existed`);
            if (unverified) parts.push(`${unverified} unverified`);
            upd(id, {
              status: created === 0 ? "exists" : "created",
              detail: (parts.length ? parts.join(", ") : "already exists") + suffix,
            });
          }
        } catch (e) {
          upd(id, { status: "error", detail: String(e) });
        }
      }

      // ── 4. Issues — generated from the FEATURES (one issue per feature, #plan-db): issues are
      //      never authored during planning, so publish is where they come into existence. Each is
      //      pinned to its milestone + added to the board. Falls back to one tracking issue per
      //      phase when there are no features. Idempotent. ──
      const planIssues = featuresToPlanIssues(parseFeaturesFile(sections.find(s => s.k === "features")?.content ?? ""));
      // Materialize them into the plan store too, so the fleet/director have issues to coordinate on
      // (the execution substrate) — publish populates the DB issues table from the DB features.
      for (const iss of planIssues) {
        await invoke("plan_upsert_issue", { projectKey: effectiveProjectId, issue: iss }).catch((e) => console.warn(`plan_upsert_issue ${iss.ref}: ${e}`));
      }
      const phaseNames = phases.map(p => p.name);
      for (const [repoIdx, fullName] of repos.entries()) {
        // Check what already exists BEFORE creating so a re-sync never duplicates.
        // Fail CLOSED: if we can't fetch the repo's issues, skip creating here.
        let existingTitles: string[];
        try {
          const existing = await rest<{ title: string }[]>(`repos/${fullName}/issues?state=all&per_page=100`);
          existingTitles = existing.map(i => i.title);
        } catch {
          if (planIssues.length) {
            for (const iss of planIssues) upd(`issue:${fullName}:${iss.ref}`, { status: "error", detail: "couldn't verify existing issues — skipped" });
          } else {
            for (let pi = 0; pi < phases.length; pi++) upd(`issue:${fullName}:${pi}`, { status: "error", detail: "couldn't verify existing issues — skipped" });
          }
          continue;
        }

        if (planIssues.length) {
          // Issues for THIS repo: its declared `repo`, or the default (first) repo.
          const mine = planIssues.filter(iss => iss.repo ? iss.repo === fullName : repoIdx === 0);
          // Ensure every label this repo uses exists (422 if present — harmless).
          // Provenance label first (#738) — every app-created issue carries it.
          await post(`repos/${fullName}/labels`, { name: BSC_ISSUE_LABEL, color: BSC_ISSUE_LABEL_COLOR }).catch(() => {});
          for (const name of [...new Set(mine.flatMap(iss => iss.labels))]) {
            await post(`repos/${fullName}/labels`, { name, color: "0e8a16" }).catch(() => {});
          }
          // ref → created GitHub node id, so feature parents + their sub-issues can be linked.
          const nodeByRef: Record<string, string> = {};
          for (const iss of mine) {
            const id = `issue:${fullName}:${iss.ref}`;
            if (existingTitles.includes(iss.title)) { upd(id, { status: "exists", detail: "already exists" }); continue; }
            upd(id, { status: "running" });
            try {
              const body: Record<string, unknown> = { title: iss.title, body: renderIssueBody(iss) };
              const phIdx = resolvePhaseIndex(iss.phase, phaseNames);
              const msNum = phIdx !== undefined ? msNumbers[fullName]?.[phIdx] : undefined;
              if (msNum !== undefined) body.milestone = msNum;
              body.labels = withProvenanceLabel(iss.labels); // provenance stamp (#738)
              const issue = await post<{ number: number; node_id: string; html_url: string }>(`repos/${fullName}/issues`, body);
              if (issue.node_id) nodeByRef[iss.ref] = issue.node_id;
              if (projectId && issue.node_id) {
                await gql(`mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item { id } } }`, { p: projectId, c: issue.node_id }).catch(() => {});
              }
              // Assign the issue to its owning stream's GitHub login (#847), defaulting to the
              // publishing account. Done as a follow-up POST AFTER the issue exists, so an
              // invalid / no-access login (a 422) is skipped gracefully and never loses the issue.
              const assignee = resolveIssueAssignee(iss.stream, fleet?.streams ?? [], viewerLogin);
              if (assignee) {
                await post(`repos/${fullName}/issues/${issue.number}/assignees`, { assignees: [assignee] }).catch(() => {});
              }
              upd(id, { status: "created", detail: `#${issue.number}`, url: issue.html_url });
            } catch (e) {
              upd(id, { status: "error", detail: String(e) });
            }
          }
          // Nest each feature's sub-issues under their parent (#…) via GraphQL addSubIssue.
          // Best-effort + idempotent: only links pairs created in THIS run; an already-linked
          // pair (or an API that doesn't support sub-issues) errors harmlessly.
          for (const { parent, child } of subIssueLinks(mine, nodeByRef)) {
            await gql(
              `mutation($p:ID!,$c:ID!){ addSubIssue(input:{issueId:$p,subIssueId:$c}){ issue { id } } }`,
              { p: parent, c: child },
            ).catch(() => {});
          }
          continue;
        }

        // Legacy fallback: one tracking issue per phase.
        await post(`repos/${fullName}/labels`, { name: BSC_ISSUE_LABEL, color: BSC_ISSUE_LABEL_COLOR }).catch(() => {}); // #738
        for (let pi = 0; pi < phases.length; pi++) {
          const ph    = phases[pi];
          const id    = `issue:${fullName}:${pi}`;
          const title = `[${ph.name}] ${projectTitle}`;
          const marker = `[${ph.name}]`;
          if (existingTitles.some(t => t.startsWith(marker))) {
            upd(id, { status: "exists", detail: "already exists" });
            continue;
          }
          upd(id, { status: "running" });
          try {
            const body: Record<string, unknown> = {
              title,
              body: `## ${ph.name}

${ph.description ?? ""}

---
_Auto-generated by base-studio-code planner._`,
              labels: [BSC_ISSUE_LABEL], // provenance stamp (#738)
            };
            const msNum = msNumbers[fullName]?.[pi];
            if (msNum !== undefined) body.milestone = msNum;
            const issue = await post<{ number: number; node_id: string; html_url: string }>(`repos/${fullName}/issues`, body);
            if (projectId && issue.node_id) {
              await gql(`mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item { id } } }`, { p: projectId, c: issue.node_id }).catch(() => {});
            }
            upd(id, { status: "created", detail: `#${issue.number}`, url: issue.html_url });
          } catch (e) {
            upd(id, { status: "error", detail: String(e) });
          }
        }
      }

      // ── 5. Stream labels — tag each fleet stream's owned issues with `stream:<id>`
      //      so ownership is visible on GitHub and the board. Ensure the label, then
      //      apply it to each owned issue resolvable by number. Idempotent. ───────
      for (const st of fleet?.streams ?? []) {
        const id    = `stream:${st.id}`;
        const label = `stream:${st.id}`;
        upd(id, { status: "running" });
        try {
          // Create the label (the request 422s if it already exists — harmless).
          await post(`repos/${st.repo}/labels`, { name: label, color: "5319e7" }).catch(() => {});
          const nums = st.issues
            .map(ref => parseInt(ref.replace(/[^0-9]/g, ""), 10))
            .filter(n => Number.isFinite(n) && n > 0);
          let applied = 0;
          for (const n of nums) {
            await post(`repos/${st.repo}/issues/${n}/labels`, { labels: [label] });
            applied++;
          }
          upd(id, applied > 0
            ? { status: "created", detail: `${applied} issue${applied === 1 ? "" : "s"} labeled` }
            : { status: "exists",  detail: "label ready · no numbered issues" });
        } catch (e) {
          upd(id, { status: "error", detail: String(e) });
        }
      }

      setPublishPhase(anyError ? "error" : "done");
    } catch (e) {
      console.error("publish failed", e);
      setPublishPhase("error");
    }
  }

  // GitHub → plan.db recovery (#plan-db). The mirror of handlePublish: pull each repo's
  // planner-published issues back into the plan store so a lost or machine-switched plan.db
  // rehydrates from the durable GitHub copy. Paginates issues (state=all), drops PRs, and upserts
  // each reconstructed PlanIssue (ref/dependsOn from the hidden marker, phase from the milestone,
  // stream from the label, status from open/closed). The 2s section poll reflects the DB afterward.
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
          await invoke("plan_upsert_issue", { projectKey: effectiveProjectId, issue: iss }).catch(() => {});
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
      const dbIssues = await invoke<PlanIssue[]>("plan_list_issues", { projectKey: effectiveProjectId })
        .catch(() => [] as PlanIssue[]);
      if (cancelled) return;
      if ((dbIssues?.length ?? 0) > 0) { setRecoverable(0); return; } // db already populated — nothing to recover
      const rows = await invoke<GitHubIssueLike[]>("github_request", {
        token: githubToken, path: `repos/${publishRepos[0]}/issues?state=all&per_page=100`,
      }).catch(() => [] as GitHubIssueLike[]);
      if (cancelled) return;
      // Count only planner-published issues — those with a ref marker (a recovered ref isn't "#<n>").
      setRecoverable(recoverIssues(rows ?? [], publishRepos[0]).filter((i) => !i.ref.startsWith("#")).length);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, githubToken, publishRepos.join(","), effectiveProjectId]);

  return { handlePublish, launchTriage, handleRecover, triaging, triageError, triageNote, recoverable, recovering, publishPhase, setPublishPhase, ghStatus };
}
