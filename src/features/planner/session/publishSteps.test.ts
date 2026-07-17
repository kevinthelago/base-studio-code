import { describe, it, expect, vi } from "vitest";
import {
  type GhApi, type Upd,
  publishRepositories, scaffoldRepositories, ensureProjectBoard,
  createIssues, applyStreamLabels, seedPublishStatus, materializeIssues,
} from "./publishSteps";
import type { GhStatusMap, GhItemState } from "./GitHubStructureCard";
import type { AgentStream } from "../fleet/planFleet";

// ── test doubles ──────────────────────────────────────────────────────────────
interface Call { method: "gql" | "rest" | "post" | "put" | "patch"; path?: string; query?: string; body?: unknown; variables?: unknown }

function makeApi(h: Partial<{
  gql: (q: string, v: unknown) => unknown;
  rest: (p: string) => unknown;
  post: (p: string, b: unknown) => unknown;
  put: (p: string, b: unknown) => unknown;
  patch: (p: string, b: unknown) => unknown;
}> = {}) {
  const calls: Call[] = [];
  const api: GhApi = {
    gql: async (query, variables) => { calls.push({ method: "gql", query, variables }); return (h.gql?.(query, variables) ?? {}) as Record<string, unknown>; },
    // rest defaults to a 404 (not found) — the steps `.catch(() => null/[])` around it.
    rest: async <T,>(path: string) => { calls.push({ method: "rest", path }); if (!h.rest) throw new Error("404"); return h.rest(path) as T; },
    post: async <T,>(path: string, body: unknown) => { calls.push({ method: "post", path, body }); return (h.post?.(path, body) ?? {}) as T; },
    put: async (path, body) => { calls.push({ method: "put", path, body }); return h.put?.(path, body); },
    patch: async (path, body) => { calls.push({ method: "patch", path, body }); return h.patch?.(path, body); },
  };
  return { api, calls };
}

function makeUpd() {
  const status: GhStatusMap = {};
  const upd: Upd = (id, patch: Partial<GhItemState>) => { status[id] = { ...(status[id] ?? { status: "planned" }), ...patch }; };
  return { status, upd };
}

const stream = (id: string, repo: string, issues: string[]): AgentStream => ({ id, repo, issues } as unknown as AgentStream);

// ── publishRepositories ─────────────────────────────────────────────────────────
describe("publishRepositories", () => {
  it("records an existing repo's node id without creating it", async () => {
    const { api, calls } = makeApi({
      gql: () => ({ viewer: { login: "me" } }),
      rest: () => ({ node_id: "R1", html_url: "u" }),
    });
    const { upd, status } = makeUpd();
    const out = await publishRepositories(api, upd, { repos: ["me/app"], projectDesc: "d", repoPublic: {}, reposPublic: {}, effectiveProjectId: "k" });
    expect(out.repoNodeIds).toEqual({ "me/app": "R1" });
    expect(out.viewerLogin).toBe("me");
    expect(status["repo:me/app"].status).toBe("exists");
    expect(calls.some(c => c.method === "post")).toBe(false); // never created
  });

  it("creates a missing repo on the user path when the owner is the viewer (private by default)", async () => {
    const { api, calls } = makeApi({
      gql: () => ({ viewer: { login: "me" } }),
      // rest throws (404) → treated as missing
      post: () => ({ node_id: "R2", html_url: "u2" }),
    });
    const { upd, status } = makeUpd();
    const out = await publishRepositories(api, upd, { repos: ["me/app"], projectDesc: "d", repoPublic: {}, reposPublic: {}, effectiveProjectId: "k" });
    const createCall = calls.find(c => c.method === "post");
    expect(createCall?.path).toBe("user/repos");
    expect((createCall?.body as { private: boolean }).private).toBe(true); // default visibility = private
    expect(out.repoNodeIds["me/app"]).toBe("R2");
    expect(status["repo:me/app"].status).toBe("created");
  });

  it("creates a missing repo under an org when the owner is not the viewer", async () => {
    const { api, calls } = makeApi({ gql: () => ({ viewer: { login: "me" } }), post: () => ({ node_id: "R3", html_url: "u" }) });
    const { upd } = makeUpd();
    await publishRepositories(api, upd, { repos: ["acme/app"], projectDesc: "", repoPublic: {}, reposPublic: {}, effectiveProjectId: "k" });
    expect(calls.find(c => c.method === "post")?.path).toBe("orgs/acme/repos");
  });

  it("still proceeds when the viewer-login query fails", async () => {
    const { api } = makeApi({ gql: () => { throw new Error("no auth"); }, post: () => ({ node_id: "R", html_url: "u" }) });
    const { upd, status } = makeUpd();
    const out = await publishRepositories(api, upd, { repos: ["acme/app"], projectDesc: "", repoPublic: {}, reposPublic: {}, effectiveProjectId: "k" });
    expect(out.viewerLogin).toBe("");
    expect(status["repo:acme/app"].status).toBe("created");
  });
});

// ── scaffoldRepositories ────────────────────────────────────────────────────────
describe("scaffoldRepositories", () => {
  const base = {
    repos: ["o/app"], projectDesc: "desc", projectTitle: "App", goalContent: "goal",
    stackText: "", scopeText: "", archText: "", features: [] as { name: string; behavior?: string }[],
    planDependencies: [], registries: {},
  };

  it("writes absent files and sets description, but never clobbers an existing file", async () => {
    // README absent (404), but one community file already present (has sha).
    const present = new Set<string>();
    const { api, calls } = makeApi({
      rest: (p) => {
        if (p.includes("/contents/README.md")) throw new Error("404");
        if (p.includes("/contents/.github/workflows")) return [];
        // every other content path: pretend it exists (return a sha) so it is skipped
        present.add(p);
        return { sha: "abc" };
      },
    });
    const { upd, status } = makeUpd();
    await scaffoldRepositories(api, upd, base);
    const puts = calls.filter(c => c.method === "put").map(c => c.path);
    expect(puts).toContain("repos/o/app/contents/README.md"); // absent → written
    expect(puts.some(p => p?.includes("CONTRIBUTING") || p?.includes("LICENSE") || p?.includes("CODE_OF_CONDUCT"))).toBe(false); // present → skipped
    expect(calls.some(c => c.method === "patch" && c.path === "repos/o/app")).toBe(true); // description applied
    expect(status["scaffold:o/app"].status).toBe("created");
  });

  it("marks a scaffold that wrote nothing as 'exists'", async () => {
    const { api } = makeApi({
      rest: (p) => p.includes("workflows") ? [] : { sha: "x" }, // every file already present
    });
    const { upd, status } = makeUpd();
    await scaffoldRepositories(api, upd, { ...base, projectDesc: "" });
    expect(status["scaffold:o/app"].status).toBe("exists");
  });
});

// ── ensureProjectBoard ───────────────────────────────────────────────────────────
describe("ensureProjectBoard", () => {
  it("reuses an existing board and links repos, returning no `created`", async () => {
    const { api, calls } = makeApi({});
    const { upd, status } = makeUpd();
    const out = await ensureProjectBoard(api, upd, {
      activeProjectId: "P1", activeProjectNumber: 7, repos: ["o/app"], viewerLogin: "me",
      projectTitle: "App", repoNodeIds: { "o/app": "RN1" },
    });
    expect(out.projectId).toBe("P1");
    expect(out.created).toBeUndefined();
    expect(status.project.status).toBe("exists");
    expect(calls.some(c => c.method === "gql" && /linkProjectV2ToRepository/.test(c.query ?? ""))).toBe(true);
  });

  it("creates a board when none exists and returns the created pv", async () => {
    const { api } = makeApi({
      gql: (q) => {
        if (/repositoryOwner/.test(q)) return { repositoryOwner: { id: "OWN" } };
        if (/createProjectV2/.test(q)) return { createProjectV2: { projectV2: { id: "PNEW", number: 12, url: "purl" } } };
        return {};
      },
    });
    const { upd, status } = makeUpd();
    const out = await ensureProjectBoard(api, upd, {
      activeProjectId: null, activeProjectNumber: null, repos: ["o/app"], viewerLogin: "me",
      projectTitle: "App", repoNodeIds: {},
    });
    expect(out.projectId).toBe("PNEW");
    expect(out.created).toEqual({ id: "PNEW", number: 12, url: "purl" });
    expect(status.project).toMatchObject({ status: "created", detail: "#12" });
  });
});

// ── createIssues ─────────────────────────────────────────────────────────────────
// Issues are generated from the FEATURES (one per feature, #plan-db) — no milestones (#1912).
describe("materializeIssues (the local half — #3280)", () => {
  const features = JSON.stringify([
    { slug: "login", name: "Add login", acceptance: ["works"] },
    { slug: "logout", name: "Add logout", acceptance: ["works"] },
  ]);

  it("parses features → issues and upserts them into plan.db, with NO GitHub call", async () => {
    const upserted: string[] = [];
    const issues = await materializeIssues(features, { upsertIssue: async (iss) => { upserted.push(iss.ref); } });
    // One issue per feature, materialized — this is exactly what lets the fleet launch offline.
    expect(issues.map(i => i.ref)).toEqual(["login", "logout"]);
    expect(upserted).toEqual(["login", "logout"]);
    // No `api` is even passed — materialization is GitHub-free by construction.
  });

  it("is idempotent by ref — commit-then-publish over the same rows never duplicates", async () => {
    const upsert = vi.fn(async () => {});
    await materializeIssues(features, { upsertIssue: upsert });
    await materializeIssues(features, { upsertIssue: upsert }); // publish later re-materializes
    // Same refs re-upserted (the store keys on ref); the caller never sees a dupe.
    expect(upsert).toHaveBeenCalledTimes(4);
    expect(new Set(upsert.mock.calls.map(c => (c[0] as { ref: string }).ref))).toEqual(new Set(["login", "logout"]));
  });

  it("empty features ⇒ no issues, no writes", async () => {
    const upsert = vi.fn(async () => {});
    expect(await materializeIssues("[]", { upsertIssue: upsert })).toEqual([]);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("createIssues (generated from features)", () => {
  const noop = { upsertIssue: vi.fn(async () => {}) };
  const features = JSON.stringify([{ slug: "login", name: "Add login", acceptance: ["works"] }]);

  it("creates one issue per feature, added to the board, with NO milestone pinning", async () => {
    const upsertIssue = vi.fn(async () => {});
    const { api, calls } = makeApi({
      rest: () => [], // no existing issues
      post: () => ({ number: 1, node_id: "N1", html_url: "iurl" }),
      gql: () => ({}),
    });
    const { upd, status } = makeUpd();
    await createIssues(api, upd, {
      repos: ["o/app"], featuresContent: features, projectId: "P", streams: [], viewerLogin: "me",
    }, { upsertIssue });
    expect(upsertIssue).toHaveBeenCalledTimes(1); // materialized into plan.db
    const issuePost = calls.find(c => c.method === "post" && c.path === "repos/o/app/issues");
    expect(issuePost).toBeTruthy();
    expect((issuePost?.body as { milestone?: number }).milestone).toBeUndefined(); // no milestone pinning (#1912)
    expect(calls.some(c => c.method === "gql" && /addProjectV2ItemById/.test(c.query ?? ""))).toBe(true);
    expect(status["issue:o/app:login"].status).toBe("created");
  });

  it("marks an already-existing feature issue as 'exists'", async () => {
    const { api } = makeApi({ rest: () => [{ title: "Add login" }] });
    const { upd, status } = makeUpd();
    await createIssues(api, upd, {
      repos: ["o/app"], featuresContent: features, projectId: undefined, streams: [], viewerLogin: "",
    }, noop);
    expect(status["issue:o/app:login"].status).toBe("exists");
  });

  it("fails CLOSED when the repo's existing-issue fetch fails", async () => {
    const { api, calls } = makeApi({ rest: () => { throw new Error("500"); } });
    const { upd, status } = makeUpd();
    await createIssues(api, upd, {
      repos: ["o/app"], featuresContent: features, projectId: undefined, streams: [], viewerLogin: "",
    }, noop);
    expect(status["issue:o/app:login"].status).toBe("error");
    expect(calls.some(c => c.method === "post" && c.path === "repos/o/app/issues")).toBe(false);
  });

  it("tags each created issue with its owning stream's label AT CREATION (#2397)", async () => {
    // A feature IS a stream (stream defaults to the slug), so the issue must be created already
    // carrying `stream:login` — no fragile post-hoc "label by predicted number" pass that 404s.
    const { api, calls } = makeApi({
      rest: () => [], post: () => ({ number: 7, node_id: "N7", html_url: "u" }), gql: () => ({}),
    });
    const { upd } = makeUpd();
    await createIssues(api, upd, {
      repos: ["o/app"], featuresContent: features, projectId: undefined, streams: [], viewerLogin: "",
    }, noop);
    // The stream label is ensured up front…
    expect(calls.some(c => c.method === "post" && c.path === "repos/o/app/labels"
      && (c.body as { name?: string }).name === "stream:login")).toBe(true);
    // …and the created issue already carries it.
    const issuePost = calls.find(c => c.method === "post" && c.path === "repos/o/app/issues");
    expect((issuePost?.body as { labels?: string[] }).labels).toContain("stream:login");
  });
});

// ── applyStreamLabels ──────────────────────────────────────────────────────────
describe("applyStreamLabels", () => {
  it("creates the label and applies it to each numbered issue", async () => {
    const { api, calls } = makeApi({});
    const { upd, status } = makeUpd();
    await applyStreamLabels(api, upd, { streams: [stream("s1", "o/app", ["#3", "#4"])] });
    const labelApplies = calls.filter(c => c.method === "post" && /\/issues\/\d+\/labels$/.test(c.path ?? ""));
    expect(labelApplies.map(c => c.path)).toEqual(["repos/o/app/issues/3/labels", "repos/o/app/issues/4/labels"]);
    expect(status["stream:s1"]).toMatchObject({ status: "created", detail: "2 issues labeled" });
  });

  it("reports 'exists' when a stream owns no numbered issues", async () => {
    const { api } = makeApi({});
    const { upd, status } = makeUpd();
    await applyStreamLabels(api, upd, { streams: [stream("s2", "o/app", [])] });
    expect(status["stream:s2"].status).toBe("exists");
  });

  it("SKIPS a plan-ref number that 404s instead of aborting or erroring the stream (#2397)", async () => {
    // #4 was never posted as a real issue → labeling it 404s. The stream must still complete: #3
    // labeled, #4 skipped — the 404 is never surfaced as a publish error (the bug this fixes).
    const { api } = makeApi({
      post: (p: string) => { if (/\/issues\/4\/labels$/.test(p)) throw new Error("404 Not Found"); return {}; },
    });
    const { upd, status } = makeUpd();
    await applyStreamLabels(api, upd, { streams: [stream("s1", "o/app", ["#3", "#4"])] });
    expect(status["stream:s1"].status).toBe("created"); // NOT "error"
    expect(status["stream:s1"].detail).toContain("1 issue labeled");
    expect(status["stream:s1"].detail).toContain("1 skipped");
  });
});

// ── seedPublishStatus ──────────────────────────────────────────────────────────
describe("seedPublishStatus", () => {
  it("seeds project, repos and streams as planned (no milestones, #1912)", () => {
    const status = seedPublishStatus({ repos: ["o/app"], streams: [stream("s1", "o/app", [])] });
    expect(status.project.status).toBe("planned");
    expect(Object.keys(status)).toEqual(expect.arrayContaining([
      "project", "repo:o/app", "stream:s1",
    ]));
  });
});
