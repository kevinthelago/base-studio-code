import { describe, it, expect } from "vitest";
import {
  isBot, dayWindow, tallyByDay, sumByDay, areaOf,
  mapVelocity, mapChurnAreas, mapHottestFiles, mapContributors, mapCI,
  mapReviewLatency, medianLatencyH, mapBranches, deriveKpis,
  type GhCommitItem, type GhCommitDetail, type GhPull, type GhBranchItem,
  type GhWorkflowItem, type GhRun,
} from "../lib/repoPulseLive";

const NOW = new Date("2026-06-10T12:00:00Z"); // window 05-28..06-10

function commit(sha: string, date: string, login: string | null, type = "User"): GhCommitItem {
  return { sha, commit: { message: "m", author: { name: login ?? "Someone", date } }, author: login ? { login, type } : null };
}
function detail(c: GhCommitItem, add: number, del: number, files: Array<[string, number, number]>): GhCommitDetail {
  return { ...c, stats: { additions: add, deletions: del, total: add + del }, files: files.map(([filename, a, d]) => ({ filename, additions: a, deletions: d, changes: a + d })) };
}

describe("isBot", () => {
  it("uses GitHub's account type and [bot] login suffix", () => {
    expect(isBot({ login: "dependabot[bot]", type: "Bot" })).toBe(true);
    expect(isBot({ login: "renovate[bot]", type: "User" })).toBe(true); // suffix
    expect(isBot({ login: "kevinthelago", type: "User" })).toBe(false);
    expect(isBot(null, "some-name")).toBe(false);
  });
});

describe("day bucketing", () => {
  const win = dayWindow(14, NOW);
  it("builds an aligned label/key window ending today", () => {
    expect(win.labels).toHaveLength(14);
    expect(win.keys[win.keys.length - 1]).toBe("2026-06-10");
    expect(win.keys[0]).toBe("2026-05-28");
  });
  it("tallies + sums by day, ignoring out-of-window", () => {
    expect(tallyByDay(win, ["2026-06-10T01:00:00Z", "2026-06-10T09:00:00Z", "2026-01-01T00:00:00Z", null])).toEqual(
      [...new Array(13).fill(0), 2]);
    expect(sumByDay(win, [{ date: "2026-06-09T00:00:00Z", value: 5 }, { date: "2026-06-09T10:00:00Z", value: 3 }])[12]).toBe(8);
  });
});

describe("mapVelocity", () => {
  it("buckets commits, opened/merged PRs, and ±lines per day", () => {
    const commits = [commit("a", "2026-06-10T01:00:00Z", "kev"), commit("b", "2026-06-10T02:00:00Z", "kev")];
    const details = [detail(commits[0], 100, 40, [["src/x.ts", 100, 40]])];
    const pulls: GhPull[] = [
      { number: 1, title: "p", user: { login: "kev" }, created_at: "2026-06-10T00:00:00Z", merged_at: "2026-06-10T03:00:00Z", draft: false, state: "closed", head: { ref: "f1" } },
      { number: 2, title: "q", user: { login: "kev" }, created_at: "2026-06-10T00:00:00Z", merged_at: null, draft: false, state: "open", head: { ref: "f2" } },
    ];
    const v = mapVelocity(commits, pulls, details, 14, NOW);
    expect(v.commits[13]).toBe(2);
    expect(v.opened[13]).toBe(2);
    expect(v.merged[13]).toBe(1);
    expect(v.adds[13]).toBe(100);
    expect(v.dels[13]).toBe(40);
  });
});

describe("churn + hottest files", () => {
  it("areaOf groups crates two-deep, others one-deep", () => {
    expect(areaOf("crates/orch/src/agent.rs")).toBe("crates/orch");
    expect(areaOf("src/screens/x.tsx")).toBe("src/");
    expect(areaOf("README.md")).toBe("(root)");
  });
  const details = [
    detail(commit("a", "2026-06-10T01:00:00Z", "kev"), 0, 0, [["crates/orch/a.rs", 100, 20], ["src/x.ts", 30, 10]]),
    detail(commit("b", "2026-06-10T02:00:00Z", "kev"), 0, 0, [["crates/orch/a.rs", 50, 5], ["crates/orch/b.rs", 10, 0]]),
  ];
  it("mapChurnAreas aggregates add/del + distinct file count", () => {
    const areas = mapChurnAreas(details);
    const orch = areas.find(a => a.area === "crates/orch")!;
    expect(orch.add).toBe(160); expect(orch.del).toBe(25); expect(orch.files).toBe(2);
    expect(areas[0].color).toBeTruthy(); // colored by rank
  });
  it("mapHottestFiles ranks by total changes", () => {
    const files = mapHottestFiles(details, 3);
    expect(files[0]).toEqual({ p: "crates/orch/a.rs", w: 175 }); // 120 + 55
  });
});

describe("mapContributors", () => {
  it("counts commits per login, sums ±lines from details, flags bots", () => {
    const c1 = commit("a", "2026-06-10T01:00:00Z", "kev");
    const c2 = commit("b", "2026-06-10T02:00:00Z", "kev");
    const c3 = commit("c", "2026-06-10T03:00:00Z", "dependabot[bot]", "Bot");
    const details = [detail(c1, 100, 20, []), detail(c3, 5, 1, [])];
    const rows = mapContributors([c1, c2, c3], details);
    const kev = rows.find(r => r.name === "kev")!;
    expect(kev.commits).toBe(2); expect(kev.add).toBe(100); expect(kev.bot).toBe(false);
    expect(rows.find(r => r.name === "dependabot[bot]")!.bot).toBe(true);
  });
});

describe("mapCI", () => {
  const wf: GhWorkflowItem[] = [{ id: 1, name: "ci.yml", path: ".github/workflows/ci.yml", state: "active" }];
  const run = (id: number, conclusion: string | null, status = "completed"): GhRun => ({
    id, name: "ci", conclusion, status, created_at: "2026-06-10T00:00:00Z", updated_at: "2026-06-10T00:04:00Z", workflow_id: 1,
  });
  it("computes pass rate over decisive runs + per-workflow", () => {
    const { ci, workflows } = mapCI([run(1, "success"), run(2, "success"), run(3, "failure"), run(4, "cancelled"), run(5, null, "in_progress")], wf);
    expect(ci.passed).toBe(2); expect(ci.failed).toBe(1); expect(ci.cancelled).toBe(1);
    expect(ci.runs).toBe(4);            // completed only
    expect(ci.passRate).toBe(67);       // 2 / (2+1)
    expect(workflows[0]).toMatchObject({ name: "ci.yml", runs: 4, pass: 50 });
  });
});

describe("review latency", () => {
  const pull = (created: string, merged: string | null): GhPull => ({
    number: 1, title: "p", user: { login: "k" }, created_at: created, merged_at: merged, draft: false, state: "closed", head: { ref: "f" },
  });
  it("buckets merged durations and computes the median", () => {
    const pulls = [
      pull("2026-06-10T00:00:00Z", "2026-06-10T00:20:00Z"), // <30m
      pull("2026-06-10T00:00:00Z", "2026-06-10T02:00:00Z"), // 1–3h
      pull("2026-06-10T00:00:00Z", null),                   // unmerged → ignored
    ];
    const buckets = mapReviewLatency(pulls);
    expect(buckets[0].v).toBe(1); // <30m
    expect(buckets[2].v).toBe(1); // 1–3h
    expect(medianLatencyH(pulls)).toBeCloseTo(1.2, 1); // median of [0.33, 2]
  });
});

describe("mapBranches", () => {
  it("derives status from default branch + open PRs, with ahead/behind", () => {
    const branches: GhBranchItem[] = [
      { name: "main", commit: { sha: "1" } },
      { name: "feature-x", commit: { sha: "2" } },
      { name: "draft-y", commit: { sha: "3" } },
      { name: "lonely", commit: { sha: "4" } },
    ];
    const pulls: GhPull[] = [
      { number: 1, title: "x", user: { login: "kev" }, created_at: "", merged_at: null, draft: false, state: "open", head: { ref: "feature-x" } },
      { number: 2, title: "y", user: { login: "bot[bot]" }, created_at: "", merged_at: null, draft: true, state: "open", head: { ref: "draft-y" } },
    ];
    const rows = mapBranches(branches, pulls, { "feature-x": { ahead_by: 5, behind_by: 1 } }, "main");
    expect(rows.find(b => b.n === "main")!.status).toBe("integration");
    const fx = rows.find(b => b.n === "feature-x")!;
    expect(fx.status).toBe("open-pr"); expect(fx.ahead).toBe(5); expect(fx.behind).toBe(1); expect(fx.owner).toBe("kev");
    expect(rows.find(b => b.n === "draft-y")!.status).toBe("draft");
    expect(rows.find(b => b.n === "draft-y")!.bot).toBe(true);
    expect(rows.find(b => b.n === "lonely")!.status).toBe("commit-only");
  });
});

describe("deriveKpis", () => {
  it("derives 7-day rollups + bot share", () => {
    const commits = [commit("a", "2026-06-10T01:00:00Z", "kev"), commit("b", "2026-06-10T02:00:00Z", "bot[bot]", "Bot")];
    const details = [detail(commits[0], 200, 50, [])];
    const v = mapVelocity(commits, [], details, 14, NOW);
    const { ci } = mapCI([], []);
    const contributors = mapContributors(commits, details);
    const pulls: GhPull[] = [{ number: 1, title: "p", user: { login: "kev" }, created_at: "2026-06-09T00:00:00Z", merged_at: "2026-06-09T02:00:00Z", draft: false, state: "closed", head: { ref: "f" } }];
    const k = deriveKpis(v, ci, pulls, contributors, NOW);
    expect(k.commitsWeek).toBe(2);
    expect(k.prsMerged).toBe(1);
    expect(k.netLines).toBe(150); // 200 - 50
    expect(k.contributors).toBe(2);
    expect(k.botShare).toBe(50); // 1 of 2 commits is a bot
  });
});
