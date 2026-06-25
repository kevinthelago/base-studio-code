import { describe, it, expect } from "vitest";
import {
  deriveLifecycleState,
  LIFECYCLE_LABEL,
  buildRefactorFleet,
  buildRefactorIssues,
  type LifecycleSignals,
} from "./planLifecycle";

// ── deriveLifecycleState ──────────────────────────────────────────────────────

describe("deriveLifecycleState (#458 lifecycle state)", () => {
  const active   = (overrides?: Partial<LifecycleSignals>): LifecycleSignals =>
    ({ isExisting: true, totalIssues: 10, closedIssues: 0, planGradeScore: 0.8, ...overrides });

  it("returns 'new' when the project is not yet published", () => {
    expect(deriveLifecycleState({ isExisting: false, totalIssues: 20, closedIssues: 15 })).toBe("new");
  });

  it("returns 'active' for an existing project with < 50% closure", () => {
    expect(deriveLifecycleState(active({ closedIssues: 4 }))).toBe("active"); // 40%
  });

  it("returns 'near-complete' when ≥75% of issues are closed", () => {
    expect(deriveLifecycleState(active({ closedIssues: 8 }))).toBe("near-complete");  // 80%
    expect(deriveLifecycleState(active({ closedIssues: 7, totalIssues: 9 }))).toBe("near-complete"); // ~78%
    expect(deriveLifecycleState(active({ closedIssues: 75, totalIssues: 100 }))).toBe("near-complete"); // 75%
  });

  it("returns 'near-complete' at 50%+ closure when the plan grade is B or better (≥0.75)", () => {
    expect(deriveLifecycleState(active({ closedIssues: 6, planGradeScore: 0.80 }))).toBe("near-complete"); // 60%+B
    expect(deriveLifecycleState(active({ closedIssues: 5, planGradeScore: 0.75 }))).toBe("near-complete"); // 50%+B
  });

  it("remains 'active' at 50%+ closure when the grade is below B", () => {
    expect(deriveLifecycleState(active({ closedIssues: 6, planGradeScore: 0.60 }))).toBe("active"); // 60%+C
    expect(deriveLifecycleState(active({ closedIssues: 5, planGradeScore: 0.74 }))).toBe("active"); // 50%+C
  });

  it("returns 'active' for a plan with no issues (ratio = 0)", () => {
    expect(deriveLifecycleState(active({ totalIssues: 0, closedIssues: 0 }))).toBe("active");
  });

  it("LIFECYCLE_LABEL maps all states", () => {
    expect(LIFECYCLE_LABEL["new"]).toBe("drafting");
    expect(LIFECYCLE_LABEL["active"]).toBe("expanding");
    expect(LIFECYCLE_LABEL["near-complete"]).toBe("near-complete");
  });
});

// ── buildRefactorFleet ────────────────────────────────────────────────────────

describe("buildRefactorFleet (#458 refactor fleet shape)", () => {
  it("produces two non-overlapping streams per repo (frontend + backend)", () => {
    const fleet = buildRefactorFleet(["acme/web"]);
    expect(fleet.streams).toHaveLength(2);
    const [fe, be] = fleet.streams;
    // fe owns src/**, be owns src-tauri/** — guaranteed non-overlapping
    expect(fe.owns).toContain("src/**");
    expect(be.owns).toContain("src-tauri/**");
    // No overlap between the two own globs
    expect(fe.owns.some(o => be.owns.includes(o))).toBe(false);
  });

  it("ids are lowercase-hyphen slugs (valid git branch names)", () => {
    const fleet = buildRefactorFleet(["My-Org/My Repo"]);
    for (const s of fleet.streams) {
      expect(s.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("produces non-overlapping streams across multiple repos", () => {
    const fleet = buildRefactorFleet(["acme/web", "acme/api"]);
    expect(fleet.streams).toHaveLength(4);
    // Each stream owns either src/** or src-tauri/**
    // Deduplicated: only two unique globs
    const unique = [...new Set(fleet.streams.flatMap(s => s.owns))];
    expect(unique).toHaveLength(2); // src/** and src-tauri/**
    // No two streams with the SAME repo own the same glob
    for (let i = 0; i < fleet.streams.length; i++) {
      for (let j = i + 1; j < fleet.streams.length; j++) {
        const a = fleet.streams[i], b = fleet.streams[j];
        if (a.repo === b.repo) {
          expect(a.owns.some(o => b.owns.includes(o))).toBe(false);
        }
      }
    }
  });

  it("enables the director when there are multiple repos", () => {
    expect(buildRefactorFleet(["a/b", "c/d"]).director.enabled).toBe(true);
  });

  it("enables the director even for a single repo (refactor PRs need a reviewer)", () => {
    expect(buildRefactorFleet(["a/b"]).director.enabled).toBe(true);
  });

  it("all streams have confirm-gate push (human reviews before landing)", () => {
    const fleet = buildRefactorFleet(["acme/web"]);
    for (const s of fleet.streams) {
      expect(s.flow?.push).toBe("push-confirm");
      expect(s.flow?.gate).toBe("hard");
    }
  });

  it("returns an empty fleet for an empty repos list", () => {
    expect(buildRefactorFleet([]).streams).toHaveLength(0);
  });
});

// ── buildRefactorIssues ───────────────────────────────────────────────────────

describe("buildRefactorIssues (#458 agent-ready refactor issues)", () => {
  it("produces agent-ready issues with acceptance criteria and owned files", () => {
    const issues = buildRefactorIssues(["acme/web"]);
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) {
      expect(i.acceptance.length).toBeGreaterThan(0);
      expect(i.owns.length).toBeGreaterThan(0);
      expect(i.stream).toBeTruthy();
      expect(i.phase).toBe("Refactor");
    }
  });

  it("assigns frontend issues to the -fe stream and backend to -be stream", () => {
    const issues = buildRefactorIssues(["acme/web"]);
    const feIssues = issues.filter(i => i.stream?.endsWith("-refactor-fe"));
    const beIssues = issues.filter(i => i.stream?.endsWith("-refactor-be"));
    expect(feIssues.length).toBeGreaterThan(0);
    expect(beIssues.length).toBeGreaterThan(0);
    for (const i of feIssues) expect(i.owns).toContain("src/**");
    for (const i of beIssues) expect(i.owns).toContain("src-tauri/**");
  });

  it("scales to multiple repos — separate issues per repo", () => {
    const single = buildRefactorIssues(["acme/web"]);
    const multi  = buildRefactorIssues(["acme/web", "acme/api"]);
    expect(multi.length).toBe(single.length * 2);
  });

  it("issue refs are stable and unique", () => {
    const issues = buildRefactorIssues(["acme/web", "acme/api"]);
    const refs = issues.map(i => i.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
