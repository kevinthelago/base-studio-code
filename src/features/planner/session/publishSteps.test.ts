import { describe, it, expect, vi } from "vitest";
import {
  type GhApi, type Upd,
  publishRepositories, scaffoldRepositories, ensureProjectBoard,
  createMilestones, createIssues, applyStreamLabels, seedPublishStatus,
} from "./publishSteps";
import type { GhStatusMap, GhItemState } from "./GitHubStructureCard";
import type { PhaseItem } from "../github/ghStructure";
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

const phase = (name: string, description = ""): PhaseItem => ({ name, description } as unknown as PhaseItem);
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

// ── createMilestones ─────────────────────────────────────────────────────────────
describe("createMilestones", () => {
  it("skips milestones when there is no repo", async () => {
    const { api, calls } = makeApi({});
    const { upd, status } = makeUpd();
    const out = await createMilestones(api, upd, { repos: [], phases: [phase("P1")], noRepo: true });
    expect(status["ms:0"].status).toBe("skipped");
    expect(out.msNumbers).toEqual({});
    expect(calls.some(c => c.method === "post")).toBe(false);
  });

  it("reuses an existing milestone by name (no create)", async () => {
    const { api, calls } = makeApi({ rest: () => [{ title: "P1", number: 5 }] });
    const { upd, status } = makeUpd();
    const out = await createMilestones(api, upd, { repos: ["o/app"], phases: [phase("P1")], noRepo: false });
    expect(out.msNumbers["o/app"][0]).toBe(5);
    expect(status["ms:0"].status).toBe("exists");
    expect(calls.some(c => c.method === "post")).toBe(false);
  });

  it("creates a missing milestone and records its number", async () => {
    const { api } = makeApi({ rest: () => [], post: () => ({ number: 9 }) });
    const { upd, status } = makeUpd();
    const out = await createMilestones(api, upd, { repos: ["o/app"], phases: [phase("P1")], noRepo: false });
    expect(out.msNumbers["o/app"][0]).toBe(9);
    expect(status["ms:0"].status).toBe("created");
  });

  it("fails CLOSED when the existing-milestone fetch fails (no create, error status)", async () => {
    const { api, calls } = makeApi({ rest: () => { throw new Error("500"); } });
    const { upd, status } = makeUpd();
    await createMilestones(api, upd, { repos: ["o/app"], phases: [phase("P1")], noRepo: false });
    expect(status["ms:0"].status).toBe("error");
    expect(calls.some(c => c.method === "post")).toBe(false); // never risk a duplicate
  });
});

// ── createIssues ─────────────────────────────────────────────────────────────────
describe("createIssues (legacy phase fallback — no features)", () => {
  const noop = { upsertIssue: vi.fn(async () => {}) };

  it("creates one tracking issue per phase, pinned to its milestone and added to the board", async () => {
    const { api, calls } = makeApi({
      rest: () => [], // no existing issues
      post: () => ({ number: 1, node_id: "N1", html_url: "iurl" }),
      gql: () => ({}),
    });
    const { upd, status } = makeUpd();
    await createIssues(api, upd, {
      repos: ["o/app"], featuresContent: "", phases: [phase("P1")], phaseNames: ["P1"],
      msNumbers: { "o/app": { 0: 5 } }, projectId: "P", streams: [], viewerLogin: "me", projectTitle: "App",
    }, noop);
    const issuePost = calls.find(c => c.method === "post" && c.path === "repos/o/app/issues");
    expect((issuePost?.body as { milestone?: number }).milestone).toBe(5);
    expect(calls.some(c => c.method === "gql" && /addProjectV2ItemById/.test(c.query ?? ""))).toBe(true);
    expect(status["issue:o/app:0"].status).toBe("created");
  });

  it("marks an already-existing phase issue as 'exists'", async () => {
    const { api } = makeApi({ rest: () => [{ title: "[P1] App" }] });
    const { upd, status } = makeUpd();
    await createIssues(api, upd, {
      repos: ["o/app"], featuresContent: "", phases: [phase("P1")], phaseNames: ["P1"],
      msNumbers: {}, projectId: undefined, streams: [], viewerLogin: "", projectTitle: "App",
    }, noop);
    expect(status["issue:o/app:0"].status).toBe("exists");
  });

  it("fails CLOSED when the repo's existing-issue fetch fails", async () => {
    const { api, calls } = makeApi({ rest: () => { throw new Error("500"); } });
    const { upd, status } = makeUpd();
    await createIssues(api, upd, {
      repos: ["o/app"], featuresContent: "", phases: [phase("P1")], phaseNames: ["P1"],
      msNumbers: {}, projectId: undefined, streams: [], viewerLogin: "", projectTitle: "App",
    }, noop);
    expect(status["issue:o/app:0"].status).toBe("error");
    expect(calls.some(c => c.method === "post" && c.path === "repos/o/app/issues")).toBe(false);
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
});

// ── seedPublishStatus ──────────────────────────────────────────────────────────
describe("seedPublishStatus", () => {
  it("seeds project, milestones, repos, per-repo issues and streams as planned", () => {
    const status = seedPublishStatus({
      repos: ["o/app"], phases: [phase("P1"), phase("P2")], streams: [stream("s1", "o/app", [])],
    });
    expect(status.project.status).toBe("planned");
    expect(Object.keys(status)).toEqual(expect.arrayContaining([
      "project", "ms:0", "ms:1", "repo:o/app", "issue:o/app:0", "issue:o/app:1", "stream:s1",
    ]));
  });
});
