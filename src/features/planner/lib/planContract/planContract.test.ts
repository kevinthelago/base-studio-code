import { describe, it, expect } from "vitest";
import {
  checkPlanContract,
  findPlanGaps,
  findOwnsOverlaps,
  DEFAULT_BLUEPRINT,
  type PlanArtifacts,
  type PlanBlueprint,
} from "./";

// ── Fixture helpers ──────────────────────────────────────────────────────────────

const REAL_CONTENT = {
  goal: "A CLI tool that runs Postgres migrations with zero local driver setup. Users are backend engineers on CI and local dev. Success = migrations run reliably across environments.",
  scope: "## In scope\n- up/down/status commands\n- cross-platform binary\n\n## Out of scope\n- GUI, managed hosting",
  stack: "| Layer | Choice |\n|---|---|\n| Runtime | Node.js 22 |\n| Datastore | Postgres via sqlx |\n| CLI | clap v4 |",
  architecture: "Two components: **runner** (executes migrations in order) and **reporter** (streams status). They communicate via an in-process channel.",
};

const VALID_ISSUES = JSON.stringify([
  { ref: "F1", title: "Add up command", acceptance: ["applies pending migrations", "returns 200"], owns: ["src/up.ts"], dependsOn: [], labels: ["scope:core"] },
  { ref: "F2", title: "Add status command", acceptance: ["lists pending + applied"], owns: ["src/status.ts"], dependsOn: ["F1"], labels: [] },
]);

const VALID_FLEET = JSON.stringify({
  recommended: 2,
  reasoning: "two independent areas",
  streams: [
    { id: "api", name: "API", repo: "acme/cli", owns: ["src/api/**"], issues: ["F1"], dependsOn: [] },
    { id: "cli", name: "CLI", repo: "acme/cli", owns: ["src/cli/**"], issues: ["F2"], dependsOn: ["api"] },
  ],
  director: { enabled: false },
});

function validArtifacts(overrides: Partial<PlanArtifacts> = {}): PlanArtifacts {
  return {
    sections: { ...REAL_CONTENT },
    confirmedSections: ["goal", "scope", "stack", "architecture"],
    issuesJson: VALID_ISSUES,
    fleetJson: VALID_FLEET,
    ...overrides,
  };
}

// ── checkPlanContract — happy path ───────────────────────────────────────────────

describe("checkPlanContract — valid plan", () => {
  it("passes a fully valid plan with no violations or warnings", () => {
    const r = checkPlanContract(validArtifacts());
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  it("passes when issues.json is empty (no issues defined yet)", () => {
    const r = checkPlanContract(validArtifacts({ issuesJson: "" }));
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it("passes when fleet.json is absent", () => {
    const r = checkPlanContract(validArtifacts({ fleetJson: "" }));
    expect(r.ok).toBe(true);
  });

  it("passes when fleet.json has only one stream (no overlap possible)", () => {
    const oneStream = JSON.stringify({
      recommended: 1, reasoning: "", director: { enabled: false },
      streams: [{ id: "main", name: "Main", repo: "acme/app", owns: ["src/**"], issues: [], dependsOn: [] }],
    });
    const r = checkPlanContract(validArtifacts({ fleetJson: oneStream }));
    expect(r.ok).toBe(true);
  });
});

// ── Stage section checks ─────────────────────────────────────────────────────────

describe("checkPlanContract — stage section violations", () => {
  it("flags a missing required section", () => {
    const sections = { ...REAL_CONTENT };
    delete (sections as Record<string, string>).goal;
    const r = checkPlanContract(validArtifacts({ sections }));
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.code === "STAGE_SECTION_MISSING" && v.message.includes('"goal"'))).toBe(true);
  });

  it("flags an empty required section", () => {
    const r = checkPlanContract(validArtifacts({ sections: { ...REAL_CONTENT, stack: "   " } }));
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.code === "STAGE_SECTION_EMPTY" && v.message.includes('"stack"'))).toBe(true);
  });

  it("flags a placeholder-only required section", () => {
    const r = checkPlanContract(validArtifacts({ sections: { ...REAL_CONTENT, scope: "TODO: fill in scope later" } }));
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.code === "STAGE_SECTION_PLACEHOLDER" && v.message.includes('"scope"'))).toBe(true);
  });

  it("flags TBD placeholders", () => {
    const r = checkPlanContract(validArtifacts({ sections: { ...REAL_CONTENT, architecture: "TBD" } }));
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.code === "STAGE_SECTION_PLACEHOLDER")).toBe(true);
  });

  it("flags an unconfirmed required section", () => {
    const r = checkPlanContract(validArtifacts({ confirmedSections: ["goal", "scope", "stack"] })); // architecture not confirmed
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.code === "STAGE_SECTION_UNCONFIRMED" && v.message.includes('"architecture"'))).toBe(true);
  });

  it("allows additional confirmed sections beyond the required set", () => {
    const r = checkPlanContract(validArtifacts({
      sections: { ...REAL_CONTENT, users: "Backend engineers on CI and local dev." },
      confirmedSections: ["goal", "scope", "stack", "architecture", "users"],
    }));
    expect(r.ok).toBe(true);
  });
});

// ── issues.json checks ───────────────────────────────────────────────────────────

describe("checkPlanContract — issues.json violations", () => {
  it("flags duplicate issue refs", () => {
    const dup = JSON.stringify([
      { ref: "F1", title: "Add up command", acceptance: ["works"], owns: [], dependsOn: [], labels: [] },
      { ref: "F1", title: "Duplicate", acceptance: ["works"], owns: [], dependsOn: [], labels: [] },
    ]);
    const r = checkPlanContract(validArtifacts({ issuesJson: dup }));
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.code === "ISSUES_DUPLICATE_REF")).toBe(true);
  });

  it("flags dangling dependencies", () => {
    const dangling = JSON.stringify([
      { ref: "F1", title: "Add up", acceptance: ["works"], owns: [], dependsOn: ["ghost"], labels: [] },
    ]);
    const r = checkPlanContract(validArtifacts({ issuesJson: dangling }));
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.code === "ISSUES_DANGLING_DEP")).toBe(true);
  });

  it("a clean issue set with resolvable deps passes", () => {
    const valid = JSON.stringify([
      { ref: "F1", title: "A", acceptance: ["x"], owns: [], dependsOn: [], labels: [] },
    ]);
    const r = checkPlanContract(validArtifacts({ issuesJson: valid }));
    expect(r.ok).toBe(true);
  });

  it("surfaces missing acceptance as a warning, not a violation", () => {
    const noAc = JSON.stringify([
      { ref: "F1", title: "No acceptance", owns: [], dependsOn: [], labels: [] },
    ]);
    const r = checkPlanContract(validArtifacts({ issuesJson: noAc }));
    expect(r.ok).toBe(true); // not a violation
    expect(r.warnings.some(w => w.code === "ISSUES_MISSING_ACCEPTANCE" && w.message.includes('"F1"'))).toBe(true);
  });
});

// ── fleet.json checks ────────────────────────────────────────────────────────────

describe("checkPlanContract — fleet.json owns overlap", () => {
  it("flags streams with exact duplicate owns globs", () => {
    const overlap = JSON.stringify({
      recommended: 2, reasoning: "", director: { enabled: false },
      streams: [
        { id: "a", name: "A", repo: "r", owns: ["src/auth/**"], issues: [], dependsOn: [] },
        { id: "b", name: "B", repo: "r", owns: ["src/auth/**"], issues: [], dependsOn: [] },
      ],
    });
    const r = checkPlanContract(validArtifacts({ fleetJson: overlap }));
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.code === "FLEET_OWNS_OVERLAP")).toBe(true);
  });

  it("flags a broad glob that subsumes a narrower one", () => {
    const subsumes = JSON.stringify({
      recommended: 2, reasoning: "", director: { enabled: false },
      streams: [
        { id: "a", name: "A", repo: "r", owns: ["src/**"], issues: [], dependsOn: [] },
        { id: "b", name: "B", repo: "r", owns: ["src/auth/**"], issues: [], dependsOn: [] },
      ],
    });
    const r = checkPlanContract(validArtifacts({ fleetJson: subsumes }));
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.code === "FLEET_OWNS_OVERLAP" && v.message.includes('"a"') && v.message.includes('"b"'))).toBe(true);
  });

  it("passes streams with non-overlapping owns", () => {
    const r = checkPlanContract(validArtifacts({ fleetJson: VALID_FLEET }));
    expect(r.ok).toBe(true);
    expect(r.violations.filter(v => v.code === "FLEET_OWNS_OVERLAP")).toHaveLength(0);
  });
});

// ── Blueprint configuration ──────────────────────────────────────────────────────

describe("checkPlanContract — custom blueprint", () => {
  it("skips disabled stages entirely", () => {
    const blueprint: PlanBlueprint = {
      ...DEFAULT_BLUEPRINT,
      stages: DEFAULT_BLUEPRINT.stages.map(s => ({ ...s, enabled: false })),
    };
    // Even with a plan missing all sections, disabled stages don't fire.
    const r = checkPlanContract({ sections: {}, confirmedSections: [], issuesJson: "", fleetJson: "" }, blueprint);
    // Only fleet/issues checks could fire here (but those artifacts are also empty).
    expect(r.violations.filter(v => v.code.startsWith("STAGE_"))).toHaveLength(0);
  });

  it("skips issues check when requiresAgentReadyIssues is false", () => {
    const dup = JSON.stringify([
      { ref: "F1", title: "A", acceptance: [], owns: [], dependsOn: [], labels: [] },
      { ref: "F1", title: "B", acceptance: [], owns: [], dependsOn: [], labels: [] },
    ]);
    const blueprint: PlanBlueprint = { ...DEFAULT_BLUEPRINT, requiresAgentReadyIssues: false };
    const r = checkPlanContract(validArtifacts({ issuesJson: dup }), blueprint);
    expect(r.violations.some(v => v.code.startsWith("ISSUES_"))).toBe(false);
  });

  it("skips fleet check when requiresDisjointOwns is false", () => {
    const overlap = JSON.stringify({
      recommended: 2, reasoning: "", director: { enabled: false },
      streams: [
        { id: "a", name: "A", repo: "r", owns: ["src/**"], issues: [], dependsOn: [] },
        { id: "b", name: "B", repo: "r", owns: ["src/auth/**"], issues: [], dependsOn: [] },
      ],
    });
    const blueprint: PlanBlueprint = { ...DEFAULT_BLUEPRINT, requiresDisjointOwns: false };
    const r = checkPlanContract(validArtifacts({ fleetJson: overlap }), blueprint);
    expect(r.violations.some(v => v.code === "FLEET_OWNS_OVERLAP")).toBe(false);
  });
});

// ── findPlanGaps ─────────────────────────────────────────────────────────────────

describe("findPlanGaps", () => {
  it("returns empty for sections with real content", () => {
    expect(findPlanGaps(REAL_CONTENT, ["goal", "scope", "stack", "architecture"])).toHaveLength(0);
  });

  it("reports missing for an absent key", () => {
    const gaps = findPlanGaps({}, ["goal"]);
    expect(gaps).toEqual([{ key: "goal", reason: "missing" }]);
  });

  it("reports empty for blank content", () => {
    const gaps = findPlanGaps({ goal: "   " }, ["goal"]);
    expect(gaps).toEqual([{ key: "goal", reason: "empty" }]);
  });

  it("reports placeholder for TODO/TBD/PLACEHOLDER keywords", () => {
    for (const kw of ["TODO: fill later", "TBD", "PLACEHOLDER content", "tbd", "todo"]) {
      const gaps = findPlanGaps({ goal: kw }, ["goal"]);
      expect(gaps[0]?.reason).toBe("placeholder");
    }
  });

  it("reports placeholder for headings-only content with no body", () => {
    const gaps = findPlanGaps({ goal: "# Goal\n" }, ["goal"]);
    expect(gaps[0]?.reason).toBe("placeholder");
  });

  it("does not report placeholder for real short content after heading", () => {
    // "# Goal\nA CLI tool" — body "A CLI tool" is 10 chars, boundary case
    // anything >= 10 non-whitespace body chars is not a placeholder
    const gaps = findPlanGaps({ goal: "# Goal\nA CLI tool that does X and Y." }, ["goal"]);
    expect(gaps).toHaveLength(0);
  });
});

// ── findOwnsOverlaps ─────────────────────────────────────────────────────────────

describe("findOwnsOverlaps", () => {
  const s = (id: string, owns: string[]) => ({ id, owns });

  it("returns empty for disjoint owns", () => {
    expect(findOwnsOverlaps([s("a", ["src/auth/**"]), s("b", ["src/components/**"])])).toHaveLength(0);
  });

  it("detects exact duplicate globs", () => {
    const overlaps = findOwnsOverlaps([s("a", ["src/auth/**"]), s("b", ["src/auth/**"])]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({ streamA: "a", streamB: "b", globA: "src/auth/**", globB: "src/auth/**" });
  });

  it("detects when a broad glob subsumes a narrower one", () => {
    const overlaps = findOwnsOverlaps([s("a", ["src/**"]), s("b", ["src/auth/**"])]);
    expect(overlaps.some(o => o.streamA === "a" && o.streamB === "b")).toBe(true);
  });

  it("detects when a file path falls under a glob prefix", () => {
    const overlaps = findOwnsOverlaps([s("a", ["src/auth/**"]), s("b", ["src/auth/LoginForm.tsx"])]);
    expect(overlaps).toHaveLength(1);
  });

  it("handles backslash-normalized globs (Windows paths)", () => {
    const overlaps = findOwnsOverlaps([s("a", ["src\\auth\\**"]), s("b", ["src/auth/**"])]);
    expect(overlaps).toHaveLength(1);
  });

  it("does not flag single-stream fleets (no pairs to compare)", () => {
    expect(findOwnsOverlaps([s("a", ["src/**"])])).toHaveLength(0);
  });

  it("handles empty owns gracefully", () => {
    expect(findOwnsOverlaps([s("a", []), s("b", [])])).toHaveLength(0);
  });
});
