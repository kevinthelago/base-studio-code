import { describe, it, expect } from "vitest";
import {
  computeAllocation,
  computeProjectStats,
  countLinkedRepos,
  type GhProject,
} from "./projectsSummaryDerive";

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

describe("computeAllocation", () => {
  it("computes percent share across active projects with items", () => {
    const projects = [
      project({ id: "a", title: "A", items: { totalCount: 3 } }),
      project({ id: "b", title: "B", items: { totalCount: 1 } }),
      project({ id: "c", title: "C", items: { totalCount: 0 } }),                // excluded (no items)
      project({ id: "d", title: "D", closed: true, items: { totalCount: 5 } }),  // excluded (closed)
    ];
    const alloc = computeAllocation(projects);
    expect(alloc.map(a => [a.n, a.pct])).toEqual([["A", 75], ["B", 25]]);
  });
});

describe("computeProjectStats + countLinkedRepos", () => {
  it("derives status + lead repo from the project data (#3675 — no per-repo issue fetch)", () => {
    const projects = [
      project({ id: "a", title: "A", items: { totalCount: 2 }, repositories: { nodes: [{ nameWithOwner: "o/repo-a" }] } }),
      project({ id: "b", title: "B", items: { totalCount: 0 } }),
      project({ id: "c", title: "C", closed: true }),
    ];
    const stats = computeProjectStats(projects);
    expect(stats.map(s => s.status)).toEqual(["active", "drafting", "shipped"]);
    expect(stats[0].repo).toBe("o/repo-a");
    expect(stats[1].repo).toBe("(no repo)");
    expect(countLinkedRepos(projects)).toBe(1);
  });
});
