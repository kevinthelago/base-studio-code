import { describe, it, expect } from "vitest";
import {
  letterFromScore,
  letterColor,
  gradeColor,
  gradeIssue,
  gradeMilestone,
  gradeRepo,
  gradePlan,
} from "../lib/planGrade";
import type { PlanIssue } from "../screens/planner/issues/planIssues";

describe("grade color is one source of truth (#686)", () => {
  it("gradeColor routes a score through the letter tiers — so a bar matches its chip", () => {
    for (const s of [0.97, 0.8, 0.65, 0.5, 0.2]) {
      expect(gradeColor(s)).toBe(letterColor(letterFromScore(s)));
    }
  });
  it("the disputed tiers no longer disagree across the score range", () => {
    expect(gradeColor(0.95)).toBe("var(--success)");          // A
    expect(gradeColor(0.50)).toBe(letterColor("D"));          // 50% → D (was orange vs red across panes)
    expect(gradeColor(0.30)).toBe("var(--danger)");           // F
    // each tier is a distinct color
    expect(new Set(["A", "B", "C", "D", "F"].map((l) => letterColor(l as never))).size).toBe(5);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

const issue = (p: Partial<PlanIssue>): PlanIssue => ({
  ref: "F1", title: "Do the thing properly here", acceptance: [], owns: [], dependsOn: [],
  labels: [], phase: 1, stream: "auth-ui", ...p,
});

const phases = [{ name: "Phase 1" }, { name: "Phase 2" }];

// ── letterFromScore ───────────────────────────────────────────────────────────

describe("letterFromScore", () => {
  it("maps score bands to letters", () => {
    expect(letterFromScore(1.0)).toBe("A");
    expect(letterFromScore(0.90)).toBe("A");
    expect(letterFromScore(0.89)).toBe("B");
    expect(letterFromScore(0.75)).toBe("B");
    expect(letterFromScore(0.74)).toBe("C");
    expect(letterFromScore(0.60)).toBe("C");
    expect(letterFromScore(0.59)).toBe("D");
    expect(letterFromScore(0.45)).toBe("D");
    expect(letterFromScore(0.44)).toBe("F");
    expect(letterFromScore(0)).toBe("F");
  });
});

// ── gradeIssue ────────────────────────────────────────────────────────────────

describe("gradeIssue", () => {
  it("A for a fully-ready issue", () => {
    const g = gradeIssue(issue({ acceptance: ["returns 200", "has a test"], owns: ["src/api/**"] }));
    expect(g.letter).toBe("A");
    expect(g.reasons).toHaveLength(0);
  });

  it("F for a bare issue with no acceptance, owns, phase, stream, or descriptive title", () => {
    const g = gradeIssue(issue({ ref: "X", title: "Foo", acceptance: [], owns: [], phase: undefined, stream: undefined }));
    expect(g.letter).toBe("F");
    expect(g.reasons.length).toBeGreaterThan(0);
    expect(g.reasons.some(r => /acceptance/i.test(r))).toBe(true);
  });

  it("partial credit for a single acceptance criterion", () => {
    const full  = gradeIssue(issue({ acceptance: ["a", "b"] }));
    const one   = gradeIssue(issue({ acceptance: ["a"] }));
    const none  = gradeIssue(issue({ acceptance: [] }));
    expect(full.score).toBeGreaterThan(one.score);
    expect(one.score).toBeGreaterThan(none.score);
    expect(one.reasons.some(r => /1 acceptance/i.test(r))).toBe(true);
  });

  it("surfaces missing owned files", () => {
    const g = gradeIssue(issue({ owns: [] }));
    expect(g.reasons.some(r => /owned files/i.test(r))).toBe(true);
  });

  it("surfaces missing phase", () => {
    const g = gradeIssue(issue({ phase: undefined }));
    expect(g.reasons.some(r => /milestone/i.test(r))).toBe(true);
  });

  it("surfaces missing stream", () => {
    const g = gradeIssue(issue({ stream: undefined }));
    expect(g.reasons.some(r => /stream/i.test(r))).toBe(true);
  });
});

// ── gradeMilestone ─────────────────────────────────────────────────────────────

describe("gradeMilestone", () => {
  it("F for an empty milestone", () => {
    const g = gradeMilestone("M1", []);
    expect(g.letter).toBe("F");
    expect(g.reasons.some(r => /no issues/i.test(r))).toBe(true);
  });

  it("rolls up issue scores with a penalty for a single-issue milestone", () => {
    const g = gradeMilestone("M1", [issue({ acceptance: ["a", "b"], owns: ["src/**"] })]);
    expect(g.score).toBeLessThan(gradeIssue(issue({ acceptance: ["a", "b"], owns: ["src/**"] })).score);
    expect(g.reasons.some(r => /too few/i.test(r) || /only 1/i.test(r))).toBe(true);
  });

  it("applies a mild penalty for too many issues (>15)", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      issue({ ref: `F${i}`, acceptance: ["a", "b"], owns: ["src/**"] }));
    const g = gradeMilestone("M1", many);
    expect(g.reasons.some(r => /unusually many/i.test(r))).toBe(true);
  });

  it("rolls up multiple issue scores with no penalty for sensible granularity (2–15)", () => {
    const issues = [
      issue({ ref: "A", acceptance: ["a", "b"], owns: ["src/**"] }),
      issue({ ref: "B", acceptance: ["c"], owns: ["src/**"] }),
    ];
    const g = gradeMilestone("M1", issues);
    const avgIssue = (gradeIssue(issues[0]).score + gradeIssue(issues[1]).score) / 2;
    expect(g.score).toBeCloseTo(avgIssue, 3);
  });
});

// ── gradeRepo ─────────────────────────────────────────────────────────────────

describe("gradeRepo", () => {
  it("F with reason when a repo has no attributed issues", () => {
    const g = gradeRepo("acme/web", [], phases);
    expect(g.letter).toBe("F");
    expect(g.reasons.some(r => /no issues/i.test(r))).toBe(true);
  });

  it("flags unscheduled issues with a reason", () => {
    const issues = [issue({ repo: "acme/web", phase: undefined, ref: "U1", acceptance: ["a", "b"], owns: ["x"] })];
    const g = gradeRepo("acme/web", issues, phases);
    expect(g.reasons.some(r => /unscheduled/i.test(r))).toBe(true);
  });
});

// ── gradePlan ─────────────────────────────────────────────────────────────────

describe("gradePlan (#445 overall rollup)", () => {
  it("F for an empty plan", () => {
    expect(gradePlan([], phases, ["acme/web"]).letter).toBe("F");
    expect(gradePlan([], phases, ["acme/web"]).reasons.some(r => /no issues/i.test(r))).toBe(true);
  });

  it("F when no repos are linked", () => {
    expect(gradePlan([issue({})], phases, []).letter).toBe("F");
  });

  it("A for a fully-ready plan", () => {
    const issues = [
      issue({ ref: "A", repo: "acme/web", acceptance: ["a","b"], owns: ["src/**"], phase: 1, stream: "s" }),
      issue({ ref: "B", repo: "acme/web", acceptance: ["c","d"], owns: ["src/**"], phase: 1, stream: "s" }),
    ];
    const g = gradePlan(issues, phases, ["acme/web"]);
    expect(g.letter).toBe("A");
    expect(g.repoGrades).toHaveLength(1);
    expect(g.repoGrades[0].repo).toBe("acme/web");
  });

  it("attributes issues with no repo to the first linked repo", () => {
    const issues = [
      issue({ ref: "X", repo: undefined, acceptance: ["a","b"], owns: ["src/**"] }),
      issue({ ref: "Y", repo: undefined, acceptance: ["c","d"], owns: ["src/**"] }),
    ];
    const g = gradePlan(issues, phases, ["acme/web"]);
    expect(g.repoGrades[0].repo).toBe("acme/web");
    expect(g.score).toBeGreaterThan(0);
  });

  it("warns about orphan issues referencing an unlinked repo", () => {
    const issues = [issue({ ref: "Z", repo: "ghost/repo", acceptance: ["a"], owns: ["x"] })];
    const g = gradePlan(issues, phases, ["acme/web"]);
    expect(g.reasons.some(r => /unlinked repo/i.test(r))).toBe(true);
  });
});

// ── category breakdown + suggestions (renderable report) ───────────────────────

describe("gradePlan — categories", () => {
  it("emits one row per rubric dimension plus a granularity row, with reasonings", () => {
    const issues = [
      issue({ ref: "A", repo: "acme/web", acceptance: ["a", "b"], owns: ["src/**"] }),
      issue({ ref: "B", repo: "acme/web", acceptance: ["c", "d"], owns: ["src/**"] }),
    ];
    const g = gradePlan(issues, phases, ["acme/web"]);
    const ids = g.categories.map(c => c.id);
    expect(ids).toEqual(["acceptance", "ownership", "milestones", "streams", "titles", "granularity"]);
    const acc = g.categories.find(c => c.id === "acceptance")!;
    expect(acc.score).toBe(1);          // both issues have ≥2 criteria
    expect(acc.detail).toMatch(/2\/2 issues/);
  });

  it("scores a category by the satisfied fraction and lists shortfall examples", () => {
    const issues = [
      issue({ ref: "HAS", repo: "acme/web", owns: ["src/**"] }),
      issue({ ref: "MISS", repo: "acme/web", owns: [] }),
    ];
    const own = gradePlan(issues, phases, ["acme/web"]).categories.find(c => c.id === "ownership")!;
    expect(own.score).toBe(0.5);
    expect(own.examples).toContain("MISS");
    expect(own.examples).not.toContain("HAS");
  });
});

describe("gradePlan — suggestions", () => {
  it("a fully-ready plan produces no suggestions", () => {
    const issues = [
      issue({ ref: "A", repo: "acme/web", acceptance: ["a", "b"], owns: ["src/**"] }),
      issue({ ref: "B", repo: "acme/web", acceptance: ["c", "d"], owns: ["src/**"] }),
    ];
    expect(gradePlan(issues, phases, ["acme/web"]).suggestions).toHaveLength(0);
  });

  it("a weak plan yields prioritized suggestions, acceptance ranked highest", () => {
    const issues = [issue({ ref: "W", repo: "acme/web", acceptance: [], owns: [], stream: undefined, title: "x" })];
    const sug = gradePlan(issues, phases, ["acme/web"]).suggestions;
    expect(sug.length).toBeGreaterThan(0);
    expect(sug[0].priority).toBe("high");
    // acceptance carries the most weight, so a fully-missing acceptance dimension leads.
    expect(sug[0].category).toBe("acceptance");
    expect(sug.some(s => /acceptance/i.test(s.title))).toBe(true);
  });
});
