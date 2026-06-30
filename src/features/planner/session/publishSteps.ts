// Publish steps (#1749) — the six sequential phases of `handlePublish`, extracted from
// usePlanPublish.ts so each is independently unit-testable. The logic is verbatim; the only change is
// that the GitHub API (`gql/rest/post/put/patch`), the per-node status callback (`upd`), and the
// store/`invoke` side-effects are INJECTED rather than captured from the hook's closure. The hook
// (usePlanPublish) is now a thin orchestrator that wires these together.
//
// Every step is fail-soft in the same places it was inline: a per-node failure records an "error"
// status via `upd` and continues; fail-CLOSED branches (couldn't verify existing milestones/issues)
// are preserved exactly so a transient read failure never risks duplicate creation.

import { resolveRepoPublic } from "@/store/slices/plan";
import type { GhStatusMap, GhItemState } from "./GitHubStructureCard";
import { parseFeaturesFile, featuresToPlanIssues } from "../issues/featureList";
import { depsForRepo, mergeIntoPackageJson, mergeIntoCargoToml, buildNpmrc, buildCargoConfig, type parseDependencyManifest } from "../issues/dependencies";
import { resolveIssueAssignee } from "../fleet/fleetAssignee";
import type { AgentStream } from "../fleet/planFleet";
import { deriveTopics, buildReadme, communityFiles, type ScaffoldFile } from "../lib/repoScaffold";
import { renderIssueBody, subIssueLinks, type PlanIssue } from "../issues/planIssues";
import { BSC_ISSUE_LABEL, BSC_ISSUE_LABEL_COLOR, withProvenanceLabel } from "@/features/github/lib/issueProvenance";

/** The injected GitHub transport — the same closures handlePublish built over `invoke`. */
export interface GhApi {
  gql: (query: string, variables: unknown) => Promise<Record<string, unknown>>;
  rest: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body: unknown) => Promise<T>;
  put: (path: string, body: unknown) => Promise<unknown>;
  patch: (path: string, body: unknown) => Promise<unknown>;
}

/** Patch a single GitHub-structure node's live status (drives the GitHubStructureCard). */
export type Upd = (id: string, patch: Partial<GhItemState>) => void;

type DepManifest = ReturnType<typeof parseDependencyManifest>;

// ── 1. Repositories — verify each exists; create if missing ───────────────────
export async function publishRepositories(
  api: GhApi,
  upd: Upd,
  opts: {
    repos: string[];
    projectDesc: string;
    repoPublic: Parameters<typeof resolveRepoPublic>[0];
    reposPublic: Parameters<typeof resolveRepoPublic>[1];
    effectiveProjectId: string;
  },
): Promise<{ repoNodeIds: Record<string, string>; viewerLogin: string }> {
  const { repos, projectDesc, repoPublic, reposPublic, effectiveProjectId } = opts;
  const repoNodeIds: Record<string, string> = {};
  let viewerLogin = "";
  try {
    const v = await api.gql(`{ viewer { login } }`, null) as { viewer?: { login?: string } };
    viewerLogin = v.viewer?.login ?? "";
  } catch { /* non-fatal: fall back to org repo path */ }

  for (const fullName of repos) {
    const id = `repo:${fullName}`;
    const [owner, name] = fullName.split("/");
    upd(id, { status: "running" });
    try {
      const existing = await api.rest<{ node_id: string; html_url: string }>(`repos/${fullName}`).catch(() => null);
      if (existing?.node_id) {
        repoNodeIds[fullName] = existing.node_id;
        upd(id, { status: "exists", detail: "on github", url: existing.html_url });
      } else {
        const path = owner.toLowerCase() === viewerLogin.toLowerCase() ? "user/repos" : `orgs/${owner}/repos`;
        const created = await api.post<{ node_id: string; html_url: string }>(path, {
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
  return { repoNodeIds, viewerLogin };
}

// ── 1b. Repo presentation (#848, #1114): description (every repo), stack topics, a plan-built
//        README with CI/version badges, community-health files, and the locked dependency
//        manifests/registry config. Files are created only when ABSENT; failures are surfaced
//        in the card detail, not fatal. ──
export async function scaffoldRepositories(
  api: GhApi,
  upd: Upd,
  opts: {
    repos: string[];
    projectDesc: string;
    projectTitle: string;
    goalContent: string;
    stackText: string;
    scopeText: string;
    archText: string;
    features: { name: string; behavior?: string }[];
    planDependencies: DepManifest["dependencies"];
    registries: DepManifest["registries"];
  },
): Promise<void> {
  const { repos, projectDesc, projectTitle, goalContent, stackText, scopeText, archText, features, planDependencies, registries } = opts;
  const topics = deriveTopics(stackText);
  for (const fullName of repos) {
    const id = `scaffold:${fullName}`;
    upd(id, { status: "running" });
    try {
      // Always (re)apply the description — a create sets it, but a pre-existing repo never had it.
      let descOk = true;
      if (projectDesc) await api.patch(`repos/${fullName}`, { description: projectDesc }).catch(() => { descOk = false; });
      let topicsOk = true;
      if (topics.length) await api.put(`repos/${fullName}/topics`, { names: topics }).catch(() => { topicsOk = false; });
      // CI badges reference the repo's actual workflow files (graceful — none yet ⇒ none).
      const wfs = await api.rest<{ name: string }[]>(`repos/${fullName}/contents/.github/workflows`).catch(() => []);
      const workflows = (Array.isArray(wfs) ? wfs : []).map(w => w.name).filter(n => /\.ya?ml$/i.test(n));
      const files: ScaffoldFile[] = [
        { path: "README.md", content: buildReadme({
          fullName, description: projectDesc, goal: goalContent, scope: scopeText,
          architecture: archText, features, stackText, workflows,
        }) },
        ...communityFiles(projectTitle),
      ];
      let wrote = 0;
      for (const f of files) {
        const path = `repos/${fullName}/contents/${f.path}`;
        const exists = await api.rest<{ sha?: string }>(path).then(r => !!r?.sha).catch(() => false);
        if (exists) continue; // don't clobber an existing file
        const content = btoa(unescape(encodeURIComponent(f.content)));
        await api.put(path, { message: `docs: scaffold ${f.path}`, content }).catch(() => {});
        wrote++;
      }

      // Dependency manifests (#1111/#1127): seed package.json / Cargo.toml from the locked manifest —
      // and the registry config (.npmrc / .cargo/config.toml) for any private SOURCE — so the fleet
      // inherits identical, complete, fetchable deps from the base branch and never adds its own. An
      // ADDITIVE MERGE for the manifests — a pre-existing pinned version always wins, so we read the
      // current file, merge, and only write on a real change.
      let manifests = 0;
      const repoDeps = depsForRepo(planDependencies, fullName);
      if (repoDeps.length) {
        const shortRepo = fullName.split("/")[1] ?? fullName;
        const seedManifest = async (file: string, merge: (existing: string | null) => string | null) => {
          const path = `repos/${fullName}/contents/${file}`;
          const cur = await api.rest<{ sha?: string; content?: string }>(path).catch(() => null);
          const existing = cur?.content ? decodeURIComponent(escape(atob(cur.content.replace(/\s/g, "")))) : null;
          const merged = merge(existing);
          if (merged === null || merged === existing) return; // nothing to add / no change
          const content = btoa(unescape(encodeURIComponent(merged)));
          await api.put(path, { message: `chore: seed ${file} from the locked dependency manifest`, content, ...(cur?.sha ? { sha: cur.sha } : {}) }).catch(() => {});
          manifests++;
        };
        await seedManifest("package.json", (e) => mergeIntoPackageJson(e, shortRepo, repoDeps));
        await seedManifest("Cargo.toml", (e) => mergeIntoCargoToml(e, shortRepo, repoDeps));
        // Registry config for private sources — generated wholesale (not merged): create it only when
        // absent so a hand-tuned .npmrc / .cargo config is never clobbered.
        await seedManifest(".npmrc", (e) => (e === null ? buildNpmrc(registries, repoDeps) : null));
        await seedManifest(".cargo/config.toml", (e) => (e === null ? buildCargoConfig(registries, repoDeps) : null));
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
// Returns the resolved projectId and, when a board was newly created, the `created` board so the
// caller can perform the store writes (setActiveProjectMeta / key alias / mark_published / draft drop).
export async function ensureProjectBoard(
  api: GhApi,
  upd: Upd,
  opts: {
    activeProjectId: string | null;
    activeProjectNumber: number | null | undefined;
    repos: string[];
    viewerLogin: string;
    projectTitle: string;
    repoNodeIds: Record<string, string>;
  },
): Promise<{ projectId: string | undefined; created?: { id: string; number: number; url: string } }> {
  const { activeProjectId, activeProjectNumber, repos, viewerLogin, projectTitle, repoNodeIds } = opts;
  let projectId: string | undefined = activeProjectId ?? undefined;
  let created: { id: string; number: number; url: string } | undefined;
  const id = "project";
  upd(id, { status: "running" });
  try {
    if (projectId) {
      upd(id, { status: "exists", detail: activeProjectNumber ? `#${activeProjectNumber}` : "linked" });
    } else {
      const ownerLogin = repos[0]?.split("/")[0] || viewerLogin;
      if (!ownerLogin) throw new Error("no owner to create project under");
      const ownerData = await api.gql(
        `query($login:String!){ repositoryOwner(login:$login){ id } }`,
        { login: ownerLogin },
      ) as { repositoryOwner?: { id?: string } };
      const ownerId = ownerData.repositoryOwner?.id;
      if (!ownerId) throw new Error(`could not resolve owner '${ownerLogin}'`);
      const createdRes = await api.gql(
        `mutation($ownerId:ID!,$title:String!){
             createProjectV2(input:{ownerId:$ownerId,title:$title}){ projectV2 { id number url } }
           }`,
        { ownerId, title: projectTitle },
      ) as { createProjectV2?: { projectV2?: { id: string; number: number; url: string } } };
      const pv = createdRes.createProjectV2?.projectV2;
      if (!pv) throw new Error("project not created");
      projectId = pv.id;
      created = pv;
      upd(id, { status: "created", detail: `#${pv.number}`, url: pv.url });
    }
    // Link every repo to the board (idempotent server-side).
    for (const fullName of repos) {
      const repoNodeId = repoNodeIds[fullName];
      if (projectId && repoNodeId) {
        await api.gql(
          `mutation($p:ID!,$r:ID!){ linkProjectV2ToRepository(input:{projectId:$p,repositoryId:$r}){ repository { id } } }`,
          { p: projectId, r: repoNodeId },
        ).catch(() => { /* already linked — ignore */ });
      }
    }
  } catch (e) {
    upd(id, { status: "error", detail: String(e) });
  }
  return { projectId, created };
}

// ── 3. Issues — generated from the FEATURES (one issue per feature, #plan-db): added to the board,
//      assigned to its stream's login, with feature sub-issues nested. No milestones (#1912).
//      Idempotent, fail-CLOSED on a repo whose existing-issue fetch fails. ──
export async function createIssues(
  api: GhApi,
  upd: Upd,
  opts: {
    repos: string[];
    featuresContent: string;
    projectId: string | undefined;
    streams: AgentStream[];
    viewerLogin: string;
  },
  hooks: { upsertIssue: (iss: PlanIssue) => Promise<void> },
): Promise<void> {
  const { repos, featuresContent, projectId, streams, viewerLogin } = opts;
  const planIssues = featuresToPlanIssues(parseFeaturesFile(featuresContent));
  // Materialize them into the plan store too, so the fleet/director have issues to coordinate on.
  for (const iss of planIssues) {
    await hooks.upsertIssue(iss);
  }
  for (const [repoIdx, fullName] of repos.entries()) {
    // Check what already exists BEFORE creating so a re-sync never duplicates. Fail CLOSED: if we
    // can't fetch the repo's issues, skip creating here.
    let existingTitles: string[];
    try {
      const existing = await api.rest<{ title: string }[]>(`repos/${fullName}/issues?state=all&per_page=100`);
      existingTitles = existing.map(i => i.title);
    } catch {
      for (const iss of planIssues) upd(`issue:${fullName}:${iss.ref}`, { status: "error", detail: "couldn't verify existing issues — skipped" });
      continue;
    }

    // Issues for THIS repo: its declared `repo`, or the default (first) repo.
    const mine = planIssues.filter(iss => iss.repo ? iss.repo === fullName : repoIdx === 0);
    // Ensure every label this repo uses exists (422 if present — harmless).
    // Provenance label first (#738) — every app-created issue carries it.
    await api.post(`repos/${fullName}/labels`, { name: BSC_ISSUE_LABEL, color: BSC_ISSUE_LABEL_COLOR }).catch(() => {});
    for (const name of [...new Set(mine.flatMap(iss => iss.labels))]) {
      await api.post(`repos/${fullName}/labels`, { name, color: "0e8a16" }).catch(() => {});
    }
    // ref → created GitHub node id, so feature parents + their sub-issues can be linked.
    const nodeByRef: Record<string, string> = {};
    for (const iss of mine) {
      const id = `issue:${fullName}:${iss.ref}`;
      if (existingTitles.includes(iss.title)) { upd(id, { status: "exists", detail: "already exists" }); continue; }
      upd(id, { status: "running" });
      try {
        const body: Record<string, unknown> = { title: iss.title, body: renderIssueBody(iss) };
        body.labels = withProvenanceLabel(iss.labels); // provenance stamp (#738)
        const issue = await api.post<{ number: number; node_id: string; html_url: string }>(`repos/${fullName}/issues`, body);
        if (issue.node_id) nodeByRef[iss.ref] = issue.node_id;
        if (projectId && issue.node_id) {
          await api.gql(`mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item { id } } }`, { p: projectId, c: issue.node_id }).catch(() => {});
        }
        // Assign the issue to its owning stream's GitHub login (#847), defaulting to the publishing
        // account. Done AFTER the issue exists, so an invalid / no-access login (a 422) is skipped
        // gracefully and never loses the issue.
        const assignee = resolveIssueAssignee(iss.stream, streams, viewerLogin);
        if (assignee) {
          await api.post(`repos/${fullName}/issues/${issue.number}/assignees`, { assignees: [assignee] }).catch(() => {});
        }
        upd(id, { status: "created", detail: `#${issue.number}`, url: issue.html_url });
      } catch (e) {
        upd(id, { status: "error", detail: String(e) });
      }
    }
    // Nest each feature's sub-issues under their parent (#…) via GraphQL addSubIssue. Best-effort +
    // idempotent: only links pairs created in THIS run; an already-linked pair (or an API that
    // doesn't support sub-issues) errors harmlessly.
    for (const { parent, child } of subIssueLinks(mine, nodeByRef)) {
      await api.gql(
        `mutation($p:ID!,$c:ID!){ addSubIssue(input:{issueId:$p,subIssueId:$c}){ issue { id } } }`,
        { p: parent, c: child },
      ).catch(() => {});
    }
  }
}

// ── 4. Stream labels — tag each fleet stream's owned issues with `stream:<id>` so ownership is
//      visible on GitHub and the board. Ensure the label, then apply it to each owned issue
//      resolvable by number. Idempotent. ──
export async function applyStreamLabels(
  api: GhApi,
  upd: Upd,
  opts: { streams: AgentStream[] },
): Promise<void> {
  for (const st of opts.streams) {
    const id    = `stream:${st.id}`;
    const label = `stream:${st.id}`;
    upd(id, { status: "running" });
    try {
      // Create the label (the request 422s if it already exists — harmless).
      await api.post(`repos/${st.repo}/labels`, { name: label, color: "5319e7" }).catch(() => {});
      const nums = st.issues
        .map(ref => parseInt(ref.replace(/[^0-9]/g, ""), 10))
        .filter(n => Number.isFinite(n) && n > 0);
      let applied = 0;
      for (const n of nums) {
        await api.post(`repos/${st.repo}/issues/${n}/labels`, { labels: [label] });
        applied++;
      }
      upd(id, applied > 0
        ? { status: "created", detail: `${applied} issue${applied === 1 ? "" : "s"} labeled` }
        : { status: "exists",  detail: "label ready · no numbered issues" });
    } catch (e) {
      upd(id, { status: "error", detail: String(e) });
    }
  }
}

/** Seed every GitHub-structure node as "planned" so the card shows the full structure upfront. */
export function seedPublishStatus(opts: { repos: string[]; streams: AgentStream[] }): GhStatusMap {
  const { repos, streams } = opts;
  const status: GhStatusMap = {};
  status["project"] = { status: "planned" };
  repos.forEach(r => { status[`repo:${r}`] = { status: "planned" }; });
  streams.forEach(st => { status[`stream:${st.id}`] = { status: "planned" }; });
  return status;
}
