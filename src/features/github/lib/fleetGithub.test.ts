import { describe, it, expect } from "vitest";
import {
  mapThroughput, mapMergeQueue, deriveThroughputKpis,
  type GhPull, type GhIssueItem, type GhStatusState,
} from "./fleetGithub";

const NOW = new Date("2026-06-10T12:00:00Z"); // window 05-28..06-10

function pull(p: Partial<GhPull> = {}): GhPull {
  return { number: 1, title: "p", user: { login: "k" }, created_at: "2026-06-10T00:00:00Z", merged_at: null, draft: false, state: "open", head: { ref: "f" }, ...p };
}
function issue(p: Partial<GhIssueItem> = {}): GhIssueItem {
  return { number: 1, title: "i", closed_at: null, state: "closed", created_at: "2026-06-10T00:00:00Z", ...p };
}

describe("mapThroughput", () => {
  it("buckets merged PRs and landed (closed, non-PR) issues per day", () => {
    const pulls = [pull({ merged_at: "2026-06-10T01:00:00Z" }), pull({ number: 2, merged_at: "2026-06-10T02:00:00Z" })];
    const issues = [
      issue({ closed_at: "2026-06-10T03:00:00Z" }),
      issue({ number: 2, closed_at: "2026-06-10T04:00:00Z", pull_request: {} }), // a PR row → excluded
      issue({ number: 3, closed_at: null }), // not closed → excluded
    ];
    const t = mapThroughput(pulls, issues, 14, NOW);
    expect(t.merged[13]).toBe(2);
    expect(t.landed[13]).toBe(1); // the PR-row + open issue excluded
    expect(t.labels).toHaveLength(14);
  });
});

describe("mapMergeQueue", () => {
  it("maps PR + CI status to a state, drafts to 'draft'", () => {
    const items = [
      { pr: pull({ number: 1, title: "ready" }), repo: "o/a", status: "success" as GhStatusState },
      { pr: pull({ number: 2, title: "ci" }), repo: "o/a", status: "pending" as GhStatusState },
      { pr: pull({ number: 3, title: "broken" }), repo: "o/b", status: "failure" as GhStatusState },
      { pr: pull({ number: 4, title: "wip", draft: true }), repo: "o/b", status: null },
    ];
    const rows = mapMergeQueue(items);
    // Sorted attention-first: blocked, running, green, draft.
    expect(rows.map(r => r.state)).toEqual(["blocked", "running", "green", "draft"]);
    expect(rows.find(r => r.pr === "#1")).toMatchObject({ state: "green", repo: "o/a", title: "ready" });
    expect(rows.find(r => r.pr === "#4")).toMatchObject({ state: "draft", checks: "draft" });
  });
  it("null status (unknown) reads as running, not blocked", () => {
    expect(mapMergeQueue([{ pr: pull({ number: 9 }), repo: "o/a", status: null }])[0].state).toBe("running");
  });
});

describe("deriveThroughputKpis", () => {
  it("derives landed-today, PRs-merged-7d, and median land time", () => {
    const pulls = [
      pull({ merged_at: "2026-06-09T00:00:00Z", created_at: "2026-06-09T00:00:00Z" }), // ~0h, within 7d
      pull({ number: 2, merged_at: "2026-06-08T00:00:00Z", created_at: "2026-06-07T00:00:00Z" }), // 24h, within 7d
      pull({ number: 3, merged_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" }), // old → excluded from 7d
    ];
    const issues = [issue({ closed_at: "2026-06-10T01:00:00Z" })];
    const t = mapThroughput(pulls, issues, 14, NOW);
    const k = deriveThroughputKpis(t, pulls, NOW);
    expect(k.landedToday).toBe(1);
    expect(k.prsMergedWeek).toBe(2);
    expect(k.avgLandH).toBeCloseTo(12, 0); // median of [0, 24]
  });
});
