import { describe, it, expect } from "vitest";
import type { GHEvent, GhMilestone, GhIssueItem as GhIssue } from "@/shared/lib/github/types";
import {
  mapGHEvent,
  buildActivityFeed,
  computeVelocity,
  avgWeeklyClosed,
  countOpenIssues,
  computeUpcomingMilestones,
  countMilestonesDueSoon,
  computeAllocation,
  computeProjectStats,
  countLinkedRepos,
  type GhProject,
} from "./projectsSummaryDerive";

const DAY = 86400000;
const WEEK = 7 * DAY;

function project(p: Partial<GhProject> & { id: string; title: string }): GhProject {
  return Object.assign({
    number: 1,
    shortDescription: null,
    closed: false,
    updatedAt: new Date().toISOString(),
    items: { totalCount: 0 },
    repositories: { nodes: [] },
  }, p) as GhProject;
}

function issue(p: Partial<GhIssue>): GhIssue {
  return Object.assign({
    number: 1,
    title: "i",
    closed_at: null,
    created_at: new Date().toISOString(),
    state: "open",
  }, p) as GhIssue;
}

function ghEvent(p: Partial<GHEvent> & { type: string }): GHEvent {
  return Object.assign({
    id: "1",
    actor: { login: "octocat" },
    repo: { name: "o/repo" },
    created_at: new Date().toISOString(),
    payload: {},
  }, p) as GHEvent;
}

describe("mapGHEvent", () => {
  it("maps a PushEvent to pushed + sha/message", () => {
    const m = mapGHEvent(ghEvent({
      type: "PushEvent",
      payload: { head: "abcdef1234567", commits: [{ message: "fix bug\nbody" }] },
    }));
    expect(m).toEqual({ action: "pushed", target: "abcdef1 fix bug" });
  });

  it("maps a merged PR to merged", () => {
    const m = mapGHEvent(ghEvent({
      type: "PullRequestEvent",
      payload: { action: "closed", pull_request: { number: 7, title: "feat", merged: true } },
    }));
    expect(m).toEqual({ action: "merged", target: "#7 feat" });
  });

  it("maps a closed-but-not-merged PR to closed", () => {
    const m = mapGHEvent(ghEvent({
      type: "PullRequestEvent",
      payload: { action: "closed", pull_request: { number: 8, title: "wip", merged: false } },
    }));
    expect(m).toEqual({ action: "closed", target: "#8 wip" });
  });

  it("maps an IssueCommentEvent to commented", () => {
    const m = mapGHEvent(ghEvent({
      type: "IssueCommentEvent",
      payload: { issue: { number: 3, title: "q" } },
    }));
    expect(m).toEqual({ action: "commented", target: "#3 q" });
  });

  it("returns null for unknown event types", () => {
    expect(mapGHEvent(ghEvent({ type: "WatchEvent" }))).toBeNull();
  });
});

describe("buildActivityFeed", () => {
  it("prefers project-repo events, maps + caps at 6", () => {
    const projects = [project({ id: "p1", title: "P1", repositories: { nodes: [{ nameWithOwner: "o/repo" }] } })];
    const events = Array.from({ length: 10 }, (_, i) =>
      ghEvent({ type: "IssuesEvent", repo: { name: "o/repo" }, payload: { action: "opened", issue: { number: i, title: `i${i}` } } }),
    );
    const feed = buildActivityFeed(events, projects);
    expect(feed).toHaveLength(6);
    expect(feed[0]).toMatchObject({ action: "opened", repo: "repo", login: "octocat" });
  });

  it("falls back to all events when project-repo events are sparse", () => {
    const projects = [project({ id: "p1", title: "P1", repositories: { nodes: [{ nameWithOwner: "o/other" }] } })];
    const events = [
      ghEvent({ type: "IssuesEvent", repo: { name: "x/y" }, payload: { action: "opened", issue: { number: 1, title: "a" } } }),
    ];
    expect(buildActivityFeed(events, projects)).toHaveLength(1);
  });
});

describe("computeVelocity + avgWeeklyClosed", () => {
  it("buckets opened/closed into the last 8 weeks and averages closed", () => {
    const now = Date.now();
    const issues: Record<string, GhIssue[]> = {
      "o/r": [
        issue({ created_at: new Date(now - 1 * DAY).toISOString(), state: "open" }),
        issue({ created_at: new Date(now - 1 * DAY).toISOString(), state: "closed", closed_at: new Date(now - 1 * DAY).toISOString() }),
        issue({ created_at: new Date(now - 1 * DAY).toISOString(), state: "closed", closed_at: new Date(now - 1 * DAY).toISOString() }),
        // a PR should be ignored entirely
        issue({ created_at: new Date(now - 1 * DAY).toISOString(), state: "closed", closed_at: new Date(now - 1 * DAY).toISOString(), pull_request: {} as GhIssue["pull_request"] }),
      ],
    };
    const v = computeVelocity(issues);
    expect(v.opened).toHaveLength(8);
    expect(v.closed[7]).toBe(2); // current week
    expect(v.opened[7]).toBe(3); // 3 non-PR issues created this week
    expect(v.avgClosed).toBe((2 / 8).toFixed(1));
    expect(avgWeeklyClosed(issues)).toBe((2 / 8).toFixed(1));
  });
});

describe("countOpenIssues", () => {
  it("counts only open, non-PR issues", () => {
    const issues: Record<string, GhIssue[]> = {
      "o/r": [
        issue({ state: "open" }),
        issue({ state: "open", pull_request: {} as GhIssue["pull_request"] }),
        issue({ state: "closed", closed_at: new Date().toISOString() }),
      ],
    };
    expect(countOpenIssues(issues)).toBe(1);
  });
});

describe("computeUpcomingMilestones + countMilestonesDueSoon", () => {
  const now = Date.now();
  const ms = (p: Partial<GhMilestone>): GhMilestone =>
    Object.assign({ title: "m", open_issues: 0, closed_issues: 0, due_on: null }, p) as GhMilestone;

  it("keeps milestones due within 8 weeks, sorted soonest first, capped at 6", () => {
    const repoMilestones: Record<string, GhMilestone[]> = {
      "owner/repo": [
        ms({ title: "soon", due_on: new Date(now + 1 * WEEK).toISOString(), open_issues: 1, closed_issues: 1 }),
        ms({ title: "later", due_on: new Date(now + 5 * WEEK).toISOString() }),
        ms({ title: "beyond", due_on: new Date(now + 9 * WEEK).toISOString() }),
        ms({ title: "no-date", due_on: null }),
      ],
    };
    const up = computeUpcomingMilestones(repoMilestones);
    expect(up.map(u => u.title)).toEqual(["soon", "later"]);
    expect(up[0]).toMatchObject({ repo: "repo", pct: 0.5, overdue: false });
  });

  it("counts milestones due within the next 2 weeks", () => {
    const repoMilestones: Record<string, GhMilestone[]> = {
      "o/r": [
        ms({ due_on: new Date(now + 1 * WEEK).toISOString() }),  // in window
        ms({ due_on: new Date(now + 3 * WEEK).toISOString() }),  // beyond 2w
        ms({ due_on: new Date(now - 1 * WEEK).toISOString() }),  // overdue, excluded
      ],
    };
    expect(countMilestonesDueSoon(repoMilestones)).toBe(1);
  });
});

describe("computeAllocation", () => {
  it("computes percent share across active projects with items", () => {
    const projects = [
      project({ id: "a", title: "A", items: { totalCount: 3 } }),
      project({ id: "b", title: "B", items: { totalCount: 1 } }),
      project({ id: "c", title: "C", items: { totalCount: 0 } }),       // excluded (no items)
      project({ id: "d", title: "D", closed: true, items: { totalCount: 5 } }), // excluded (closed)
    ];
    const alloc = computeAllocation(projects);
    expect(alloc.map(a => [a.n, a.pct])).toEqual([["A", 75], ["B", 25]]);
  });
});

describe("computeProjectStats + countLinkedRepos", () => {
  it("derives status, lead repo, and a 9-point sparkline", () => {
    const now = Date.now();
    const projects = [
      project({ id: "a", title: "A", items: { totalCount: 2 }, repositories: { nodes: [{ nameWithOwner: "o/repo-a" }] } }),
      project({ id: "b", title: "B", items: { totalCount: 0 } }),
      project({ id: "c", title: "C", closed: true }),
    ];
    const repoIssues: Record<string, GhIssue[]> = {
      "o/repo-a": [issue({ state: "closed", closed_at: new Date(now - 1 * DAY).toISOString() })],
    };
    const stats = computeProjectStats(projects, repoIssues);
    expect(stats.map(s => s.status)).toEqual(["active", "drafting", "shipped"]);
    expect(stats[0].repo).toBe("o/repo-a");
    expect(stats[0].spark).toHaveLength(9);
    expect(stats[0].spark[8]).toBe(1); // closed this week
    expect(stats[1].repo).toBe("(no repo)");
    expect(countLinkedRepos(projects)).toBe(1);
  });
});
