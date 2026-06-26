import { describe, it, expect } from "vitest";
import type { GHEvent } from "@/shared/lib/github/types";
import type { GithubRepo } from "@/store";
import {
  mapEvent,
  countMergedPRs,
  buildCrossRepoEvents,
  buildOpenPRs,
  buildContributors,
  buildCiMatrix,
  buildRepoGrid,
  ciPassingPercent,
  buildHeatmap,
  langColor,
  type RepoData,
} from "./githubSummary";

function event(partial: Partial<GHEvent> & Pick<GHEvent, "type">): GHEvent {
  return {
    id: "1",
    actor: { login: "alice" },
    repo: { name: "acme/app" },
    payload: {},
    created_at: new Date().toISOString(),
    ...partial,
  } as GHEvent;
}

function repo(full_name: string, language: string | null = "TypeScript"): GithubRepo {
  return {
    full_name, private: false, language, open_issues_count: 0,
    default_branch: "main", description: "desc", pushed_at: new Date().toISOString(), stargazers_count: 0,
  };
}

describe("mapEvent", () => {
  it("maps a push event", () => {
    const r = mapEvent(event({ type: "PushEvent", payload: { head: "abcdef1234", commits: [{ message: "fix things\nbody" }] } }));
    expect(r).toEqual({ action: "pushed", target: "abcdef1 fix things" });
  });
  it("flags a merged PR", () => {
    const r = mapEvent(event({ type: "PullRequestEvent", payload: { action: "closed", pull_request: { number: 7, title: "t", merged: true } } }));
    expect(r).toEqual({ action: "merged", target: "#7 t" });
  });
  it("drops unknown event types", () => {
    expect(mapEvent(event({ type: "WatchEvent" }))).toBeNull();
  });
});

describe("countMergedPRs", () => {
  it("counts only closed+merged PR events", () => {
    const events = [
      event({ type: "PullRequestEvent", payload: { action: "closed", pull_request: { merged: true } } }),
      event({ type: "PullRequestEvent", payload: { action: "closed", pull_request: { merged: false } } }),
      event({ type: "PullRequestEvent", payload: { action: "opened", pull_request: { merged: false } } }),
      event({ type: "PushEvent" }),
    ];
    expect(countMergedPRs(events)).toBe(1);
  });
});

describe("buildCrossRepoEvents", () => {
  it("maps + caps the feed at 8 and drops unmappable events", () => {
    const events = [
      ...Array.from({ length: 10 }, () => event({ type: "PushEvent", payload: { head: "abcdef1", commits: [{ message: "m" }] } })),
      event({ type: "WatchEvent" }),
    ];
    const out = buildCrossRepoEvents(events);
    expect(out).toHaveLength(8);
    expect(out[0]).toMatchObject({ login: "alice", action: "pushed", repo: "acme/app" });
  });
});

describe("buildOpenPRs", () => {
  it("flattens ≤3 PRs per repo, caps at 8, and formats age via the injected fn", () => {
    const repoData: Record<string, RepoData> = {
      "acme/app": {
        prs: Array.from({ length: 4 }, (_, i) => ({ number: i, title: `pr${i}`, user: { login: "bob" }, created_at: "2020", draft: i === 0 })),
        langBytes: {}, runs: [], contribs: [],
      },
    };
    const out = buildOpenPRs(repoData, () => "1d");
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ n: "#0", t: "pr0", who: "bob", repo: "acme/app", draft: true, age: "1d" });
  });
});

describe("buildContributors", () => {
  it("sums commits per author across repos, sorted desc, top 5", () => {
    const repoData: Record<string, RepoData> = {
      a: { prs: [], langBytes: {}, runs: [], contribs: [{ author: { login: "x" }, total: 3 }, { author: null, total: 99 }] },
      b: { prs: [], langBytes: {}, runs: [], contribs: [{ author: { login: "x" }, total: 2 }, { author: { login: "y" }, total: 10 }] },
    };
    expect(buildContributors(repoData)).toEqual([
      { login: "y", commits: 10 },
      { login: "x", commits: 5 },
    ]);
  });
});

describe("buildCiMatrix + ciPassingPercent", () => {
  it("keeps only repos with runs and computes the latest-run pass rate", () => {
    const now = new Date().toISOString();
    const repoData: Record<string, RepoData> = {
      "acme/app": { prs: [], langBytes: {}, runs: [{ id: 1, status: "completed", conclusion: "success", created_at: now }], contribs: [] },
      "acme/lib": { prs: [], langBytes: {}, runs: [], contribs: [] },
    };
    const repos = [repo("acme/app"), repo("acme/lib")];
    const matrix = buildCiMatrix(repos, repoData);
    expect(matrix.map(m => m.name)).toEqual(["app"]);
    expect(matrix[0].days[6]).toBe(true);
    expect(ciPassingPercent(repos, repoData)).toBe(100);
  });
  it("returns null pass rate when no repo has runs", () => {
    expect(ciPassingPercent([repo("a")], { a: { prs: [], langBytes: {}, runs: [], contribs: [] } })).toBeNull();
  });
});

describe("buildRepoGrid", () => {
  it("shapes card data with PR count + CI status", () => {
    const repoData: Record<string, RepoData> = {
      "acme/app": { prs: [{ number: 1, title: "t", user: { login: "b" }, created_at: "2020", draft: false }], langBytes: {}, runs: [{ id: 1, status: "completed", conclusion: "failure", created_at: "2020" }], contribs: [] },
    };
    const [card] = buildRepoGrid([repo("acme/app")], repoData, []);
    expect(card).toMatchObject({ full_name: "acme/app", prCount: 1, ciStatus: "failing" });
    expect(card.spark).toHaveLength(12);
  });
});

describe("buildHeatmap", () => {
  it("produces 196 cells and sums total contributions", () => {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const weekday = (today.getDay()); // GitHub: 0=Sun
    const { heatmapCells, totalContribs } = buildHeatmap([{ date: iso, weekday, count: 5 }]);
    expect(heatmapCells).toHaveLength(28 * 7);
    expect(totalContribs).toBe(5);
  });
  it("is empty for no days", () => {
    const { heatmapCells, totalContribs } = buildHeatmap([]);
    expect(totalContribs).toBe(0);
    expect(heatmapCells.every(c => c === 0)).toBe(true);
  });
});

describe("langColor", () => {
  it("returns a known colour or a neutral fallback", () => {
    expect(langColor("Rust")).toContain("oklch");
    expect(langColor("Brainfuck")).toBe("oklch(0.5 0 0)");
  });
});
