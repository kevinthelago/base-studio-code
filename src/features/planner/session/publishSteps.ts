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
import { BSC_ISSUE_LABEL, BSC_ISSUE_LABEL_COLOR, withProvenanceLabel } from "@/shared/lib/github/issueProvenance";

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
/**
 * The LOCAL half of publish (#3280): parse the features section into `PlanIssue`s and materialize them
 * into plan.db, so the fleet/director have issues to coordinate on WITHOUT any GitHub round-trip. Used
 * both by `createIssues` (before the GitHub push) and by the GitHub-less commit path.
 *
 * Idempotent — `upsertIssue` keys on `ref`, so committing locally and later publishing over the same
 * rows never duplicates. Returns the parsed issues for the caller (createIssues then pushes them).
 */
export async function materializeIssues(
  featuresContent: string,
  hooks: { upsertIssue: (iss: PlanIssue) => Promise<void> },
): Promise<PlanIssue[]> {
  const planIssues = featuresToPlanIssues(parseFeaturesFile(featuresContent));
  for (const iss of planIssues) {
    await hooks.upsertIssue(iss);
  }
  return planIssues;
}

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
  hooks: {
    upsertIssue: (iss: PlanIssue) => Promise<void>;
    /** Record the GitHub identity a create (or a legacy title match) established for `ref`. */
    setIssueIdentity: (ref: string, ghNumber: number, ghNodeId?: string) => Promise<void>;
    /** The CURRENT plan.db rows, read back after materialize so their stored `ghNumber` is in hand.
     *  The parsed feature list cannot supply it — features carry no publish state — so without this
     *  read every publish would look at freshly-derived rows and think nothing had ever shipped. */
    loadIssues: () => Promise<PlanIssue[]>;
  },
): Promise<void> {
  const { repos, featuresContent, projectId, streams, viewerLogin } = opts;
  // The LOCAL half — materialize into plan.db — is shared with the GitHub-less commit path (#3280).
  const materialized = await materializeIssues(featuresContent, hooks);
  // Re-read so each issue carries the identity plan.db holds for it. `upsert` preserves `gh_number`
  // across a content edit, so this read is what turns "the features say F1 exists" into "F1 is
  // already issue #3898".
  const stored = new Map((await hooks.loadIssues().catch(() => [] as PlanIssue[])).map(i => [i.ref, i]));
  const planIssues = materialized.map(iss => {
    const s = stored.get(iss.ref);
    return s?.ghNumber ? { ...iss, ghNumber: s.ghNumber, ghNodeId: s.ghNodeId } : iss;
  });

  for (const [repoIdx, fullName] of repos.entries()) {
    // Check what already exists BEFORE creating so a re-sync never duplicates. Fail CLOSED: if we
    // can't fetch the repo's issues, skip creating here.
    let existingNumbers: Set<number>;
    // title → the first row carrying it, so the legacy title match resolves a NUMBER from the one
    // fetch above. Re-querying per issue would be the N-per-item fan-out this codebase has paid for
    // repeatedly (#3908/#3912/#3944/#3954) — and it would be worse here, once per issue per publish.
    let existingByTitle: Map<string, { number: number; node_id?: string }>;
    try {
      const existing = await api.rest<{ number: number; title: string; node_id?: string }[]>(`repos/${fullName}/issues?state=all&per_page=100`);
      existingNumbers = new Set(existing.map(i => i.number).filter(n => typeof n === "number"));
      existingByTitle = new Map();
      for (const r of existing) {
        if (r.title && !existingByTitle.has(r.title)) existingByTitle.set(r.title, { number: r.number, node_id: r.node_id });
      }
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
    // Ensure each owning stream's `stream:<id>` label up front so issues are created ALREADY tagged
    // (#2397). Labeling at creation — where the real GitHub number is in hand — avoids the fragile
    // post-hoc "label by the plan's predicted number" pass, whose numbers 404 when an issue failed to
    // post or the numbering drifted.
    for (const label of new Set(mine.map(iss => iss.stream).filter(Boolean).map(s => `stream:${s}`))) {
      await api.post(`repos/${fullName}/labels`, { name: label, color: "5319e7" }).catch(() => {});
    }
    // ref → created GitHub node id, so feature parents + their sub-issues can be linked.
    const nodeByRef: Record<string, string> = {};
    for (const iss of mine) {
      const id = `issue:${fullName}:${iss.ref}`;
      // IDENTITY FIRST. A row that knows its number is settled — no title comparison, so renaming an
      // issue no longer makes publish believe it is new and open a duplicate.
      if (iss.ghNumber && existingNumbers.has(iss.ghNumber)) {
        upd(id, { status: "exists", detail: `#${iss.ghNumber}` });
        continue;
      }
      // Title match stays ONLY for rows published before the identity column existed. When it hits we
      // backfill the number, so a legacy row is matched by title exactly once and by identity forever
      // after — the migration happens as a side effect of the next publish, with no separate pass.
      const byTitle = existingByTitle.get(iss.title);
      if (byTitle) {
        // Only link when the match actually yielded a usable number. "Exists" is still the right
        // answer without one — the issue is there and must not be re-created — but writing an
        // undefined/0 number would fabricate an identity that points at nothing, which is worse than
        // having none: the next publish would trust it and skip the issue forever.
        if (byTitle.number > 0) {
          await hooks.setIssueIdentity(iss.ref, byTitle.number, byTitle.node_id).catch(() => {});
          upd(id, { status: "exists", detail: `#${byTitle.number} · linked` });
        } else {
          upd(id, { status: "exists", detail: "already exists" });
        }
        continue;
      }
      upd(id, { status: "running" });
      try {
        const body: Record<string, unknown> = { title: iss.title, body: renderIssueBody(iss) };
        // Tag the owning stream at creation (#2397) so ownership is correct without a number-matching
        // pass. Provenance stamp (#738) rides along.
        const labels = iss.stream ? [...iss.labels, `stream:${iss.stream}`] : iss.labels;
        body.labels = withProvenanceLabel(labels);
        const issue = await api.post<{ number: number; node_id: string; html_url: string }>(`repos/${fullName}/issues`, body);
        if (issue.node_id) nodeByRef[iss.ref] = issue.node_id;
        // Record the link IMMEDIATELY, before the board-add / assignee / sub-issue calls below. Those
        // are all best-effort and any of them can throw; if the identity were written after them, a
        // failure there would leave a real GitHub issue that plan.db has no record of — and the next
        // publish would create it again. The write that must not be lost goes first.
        if (issue.number) {
          await hooks.setIssueIdentity(iss.ref, issue.number, issue.node_id).catch(() => {});
        }
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

// ── 4. Stream labels — a best-effort RECONCILIATION pass (#2397). Issues created in this publish are
//      already tagged `stream:<id>` at creation (createIssues); this pass re-applies the label to any
//      PRE-EXISTING issues the stream owns, resolvable by number. Resilient: a plan-ref number that
//      never became a real issue (a post that failed, or numbering that drifted) 404s — that issue is
//      SKIPPED, never aborting the stream or surfacing the 404 as a publish error. Idempotent. ──
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
      let skipped = 0;
      for (const n of nums) {
        // Per-issue resilience: a 404 (the number isn't a real issue) skips just that one.
        const ok = await api.post(`repos/${st.repo}/issues/${n}/labels`, { labels: [label] })
          .then(() => true).catch(() => false);
        if (ok) applied++; else skipped++;
      }
      const skipNote = skipped > 0 ? ` · ${skipped} skipped (no matching issue)` : "";
      upd(id, applied > 0
        ? { status: "created", detail: `${applied} issue${applied === 1 ? "" : "s"} labeled${skipNote}` }
        : { status: "exists",  detail: `label ready${nums.length ? skipNote : " · no numbered issues"}` });
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
