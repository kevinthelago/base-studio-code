import { describe, it, expect } from "vitest";
import { blankSkill, skillSlug, type SkillDef, type SkillGroup } from "./skills";
import type { SkillStats } from "./skillTelemetry";
import {
  mergeSkillStats, indexGroupsBySkill, buildFacetDefs, filterSkills, buildGroupedSections,
  hashN, SORTS, type FacetSelection,
} from "./skillsFilter";

const mk = (over: Partial<SkillDef>): SkillDef => ({ ...blankSkill(), id: "x", ...over });

const LIB: SkillDef[] = [
  mk({ id: "w1", name: "Open a clean PR", kind: "workflow", source: "first-party", tools: ["create_pr"], enabled: true, pinned: true, projects: [], invocations: 10, success: 90 }),
  mk({ id: "w2", name: "Cut a release", kind: "workflow", source: "team", tools: ["git_tag"], enabled: true, pinned: false, projects: ["42"], invocations: 30, success: 70 }),
  mk({ id: "sc1", name: "Scaffold a command", kind: "scaffold", source: "imported", tools: [], enabled: false, pinned: false, projects: [], invocations: 0, success: 0 }),
  mk({ id: "r1", name: "Security review", kind: "review", source: "community", tools: ["git_diff"], enabled: true, pinned: false, projects: [], invocations: 5, success: 100 }),
];

const baseArgs = (over: Partial<Parameters<typeof filterSkills>[1]> = {}) => ({
  query: "",
  groupFilter: null,
  skillGroups: [] as SkillGroup[],
  facetDefs: buildFacetDefs(LIB),
  facetSel: {} as FacetSelection,
  sort: "Most invoked" as const,
  ...over,
});

describe("hashN", () => {
  it("is deterministic for the same input", () => {
    expect(hashN("abc")).toBe(hashN("abc"));
  });
  it("differs across inputs (so 'used' vs 'added' orderings diverge)", () => {
    expect(hashN("w1u")).not.toBe(hashN("w1a"));
  });
});

describe("mergeSkillStats", () => {
  it("overlays live telemetry by name-slug and zeroes the rest", () => {
    const stats: Record<string, SkillStats> = {
      [skillSlug("Open a clean PR")]: { invocations: 12, success: 11, successRate: 92, today: 3, trend: [1, 2, 3] },
    };
    const merged = mergeSkillStats(LIB, stats);
    const w1 = merged.find((s) => s.id === "w1")!;
    expect(w1.invocations).toBe(12);
    expect(w1.success).toBe(92);
    expect(w1.trend).toEqual([1, 2, 3]);
    // a skill with no telemetry reads zero
    const r1 = merged.find((s) => s.id === "r1")!;
    expect(r1).toMatchObject({ invocations: 0, success: 0, trend: [] });
  });
  it("does not mutate the source list", () => {
    const before = LIB.map((s) => s.invocations);
    mergeSkillStats(LIB, {});
    expect(LIB.map((s) => s.invocations)).toEqual(before);
  });
});

describe("indexGroupsBySkill", () => {
  it("maps each skill id to every group it belongs to", () => {
    const groups: SkillGroup[] = [
      { id: "g1", name: "Release", hue: "var(--accent)", skillIds: ["w1", "w2"] },
      { id: "g2", name: "Quality", hue: "var(--info)", skillIds: ["w1", "r1"] },
    ];
    const idx = indexGroupsBySkill(groups);
    expect(idx.get("w1")!.map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(idx.get("w2")!.map((g) => g.id)).toEqual(["g1"]);
    expect(idx.get("sc1")).toBeUndefined();
  });
});

describe("buildFacetDefs", () => {
  it("produces the five facets with live option counts", () => {
    const facets = buildFacetDefs(LIB);
    expect(facets.map((f) => f.key)).toEqual(["kind", "source", "scope", "status", "usage"]);
    const kind = facets.find((f) => f.key === "kind")!;
    expect(kind.options.find((o) => o.value === "workflow")!.count).toBe(2);
    const scope = facets.find((f) => f.key === "scope")!;
    expect(scope.options.find((o) => o.value === "global")!.count).toBe(3);
    expect(scope.options.find((o) => o.value === "scoped")!.count).toBe(1);
    const status = facets.find((f) => f.key === "status")!;
    expect(status.options.find((o) => o.value === "enabled")!.count).toBe(3);
    expect(status.options.find((o) => o.value === "pinned")!.count).toBe(1);
    const usage = facets.find((f) => f.key === "usage")!;
    expect(usage.options.find((o) => o.value === "never")!.count).toBe(1);
  });
});

describe("filterSkills", () => {
  it("returns all skills sorted by invocations descending by default", () => {
    const out = filterSkills(LIB, baseArgs());
    expect(out.map((s) => s.id)).toEqual(["w2", "w1", "r1", "sc1"]);
  });

  it("sorts by name A–Z", () => {
    const out = filterSkills(LIB, baseArgs({ sort: "Name (A–Z)" }));
    expect(out.map((s) => s.name)).toEqual(["Cut a release", "Open a clean PR", "Scaffold a command", "Security review"]);
  });

  it("sorts by success rate descending", () => {
    const out = filterSkills(LIB, baseArgs({ sort: "Success rate" }));
    expect(out.map((s) => s.id)).toEqual(["r1", "w1", "w2", "sc1"]);
  });

  it("filters by free-text query over name/desc/tools/source", () => {
    expect(filterSkills(LIB, baseArgs({ query: "release" })).map((s) => s.id)).toEqual(["w2"]);
    // matches tool name
    expect(filterSkills(LIB, baseArgs({ query: "git_diff" })).map((s) => s.id)).toEqual(["r1"]);
    // matches source
    expect(filterSkills(LIB, baseArgs({ query: "community" })).map((s) => s.id)).toEqual(["r1"]);
  });

  it("ORs option matches within a facet, ANDs across facets", () => {
    // status: enabled OR pinned → all enabled (w1,w2,r1) plus pinned (w1) = enabled set
    const enabled = filterSkills(LIB, baseArgs({ facetSel: { status: new Set(["enabled"]) } }));
    expect(enabled.map((s) => s.id).sort()).toEqual(["r1", "w1", "w2"]);
    // kind=workflow AND scope=global → w1 only (w2 is workflow but project-scoped)
    const combined = filterSkills(LIB, baseArgs({ facetSel: { kind: new Set(["workflow"]), scope: new Set(["global"]) } }));
    expect(combined.map((s) => s.id)).toEqual(["w1"]);
  });

  it("filters to a single task group when groupFilter is set", () => {
    const groups: SkillGroup[] = [{ id: "g1", name: "Release", hue: "var(--accent)", skillIds: ["w1", "r1"] }];
    const out = filterSkills(LIB, baseArgs({ groupFilter: "g1", skillGroups: groups }));
    expect(out.map((s) => s.id).sort()).toEqual(["r1", "w1"]);
  });

  it("does not mutate the input list", () => {
    const order = LIB.map((s) => s.id);
    filterSkills(LIB, baseArgs({ sort: "Name (A–Z)" }));
    expect(LIB.map((s) => s.id)).toEqual(order);
  });

  it("exposes all five sort orders", () => {
    expect(SORTS).toHaveLength(5);
    for (const sort of SORTS) expect(filterSkills(LIB, baseArgs({ sort }))).toHaveLength(LIB.length);
  });
});

describe("buildGroupedSections", () => {
  it("sections by kind in 'kind' density, dropping empty kinds", () => {
    const secs = buildGroupedSections("kind", LIB, []);
    expect(secs.map((s) => s.id)).toEqual(["workflow", "scaffold", "review"]);
    expect(secs.find((s) => s.id === "workflow")!.items.map((i) => i.id).sort()).toEqual(["w1", "w2"]);
  });

  it("sections by task group with an Ungrouped trailer", () => {
    const groups: SkillGroup[] = [{ id: "g1", name: "Release", hue: "var(--accent)", skillIds: ["w1", "w2"] }];
    const secs = buildGroupedSections("grouped", LIB, groups);
    expect(secs.map((s) => s.id)).toEqual(["g1", "__ungrouped__"]);
    expect(secs[0].items.map((i) => i.id).sort()).toEqual(["w1", "w2"]);
    expect(secs[1].items.map((i) => i.id).sort()).toEqual(["r1", "sc1"]);
  });

  it("with no groups, everything lands in a single Ungrouped section", () => {
    const secs = buildGroupedSections("grouped", LIB, []);
    expect(secs).toHaveLength(1);
    expect(secs[0].id).toBe("__ungrouped__");
    expect(secs[0].items).toHaveLength(LIB.length);
  });
});
