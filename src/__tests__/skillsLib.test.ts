import { describe, it, expect } from "vitest";
import {
  seedSkills, resolveSkills, toSkillCfgs, skillSlug, defFromCatalog, blankSkill,
  parseSkillsFile, deriveSkillKpis, refreshPackagedSkills, type SkillDef,
} from "../lib/skills";

function def(p: Partial<SkillDef> = {}): SkillDef {
  return {
    id: "s1", name: "Open a clean PR", kind: "workflow", source: "first-party",
    desc: "d", prompt: "body", tools: ["create_pr"], profiles: ["build"],
    projects: [], enabled: true, pinned: false,
    invocations: 0, success: 0, avgTokensK: 0, trend: [], ...p,
  };
}

describe("skillSlug", () => {
  it("lowercases, collapses non-alnum runs, and trims dashes", () => {
    expect(skillSlug("Open a clean PR")).toBe("open-a-clean-pr");
    expect(skillSlug("  Wire a new MCP tool! ")).toBe("wire-a-new-mcp-tool");
    expect(skillSlug("***")).toBe("");
  });
});

describe("seedSkills", () => {
  it("returns the sample library, all enabled + global", () => {
    const seed = seedSkills();
    expect(seed.length).toBeGreaterThan(0);
    expect(seed.every(s => s.enabled)).toBe(true);
    expect(seed.every(s => s.projects.length === 0)).toBe(true);
    expect(seed.every(s => typeof s.prompt === "string")).toBe(true);
  });
});

describe("resolveSkills", () => {
  const all = [
    def({ id: "a", enabled: true, projects: [] }),
    def({ id: "b", enabled: false, projects: [] }),
    def({ id: "c", enabled: true, projects: ["proj1"] }),
    def({ id: "d", enabled: true, projects: ["proj2"] }),
  ];
  it("includes enabled global + enabled scoped-to-this-project, excludes disabled/other", () => {
    const r = resolveSkills(all, "proj1").map(s => s.id);
    expect(r).toContain("a");
    expect(r).toContain("c");
    expect(r).not.toContain("b"); // disabled
    expect(r).not.toContain("d"); // other project
  });
  it("with no project yields only global", () => {
    expect(resolveSkills(all, "").map(s => s.id)).toEqual(["a"]);
  });
});

describe("toSkillCfgs", () => {
  it("maps to the backend payload and skips name-less skills", () => {
    const cfgs = toSkillCfgs([def({ name: "Open a clean PR" }), def({ id: "x", name: "***" })]);
    expect(cfgs).toEqual([{ name: "Open a clean PR", description: "d", prompt: "body", tools: ["create_pr"] }]);
  });
});

describe("defFromCatalog / blankSkill", () => {
  it("catalog entry comes disabled + global with the catalog description", () => {
    const d = defFromCatalog("ISO 27001 control mapping");
    expect(d.name).toBe("ISO 27001 control mapping");
    expect(d.enabled).toBe(false);
    expect(d.projects).toEqual([]);
    expect(d.desc.length).toBeGreaterThan(0);
  });
  it("unknown catalog name still yields a usable workflow def", () => {
    const d = defFromCatalog("Totally unknown");
    expect(d.kind).toBe("workflow");
    expect(d.enabled).toBe(false);
  });
  it("blankSkill is an empty, disabled workflow", () => {
    const b = blankSkill();
    expect(b.name).toBe("");
    expect(b.kind).toBe("workflow");
    expect(b.enabled).toBe(false);
  });
});

describe("parseSkillsFile", () => {
  it("parses a well-formed array with defaults (enabled + pinned)", () => {
    const out = parseSkillsFile(JSON.stringify([
      { name: "Ship it", kind: "review", description: "desc", prompt: "p", tools: ["git_diff"], profiles: ["review"] },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "Ship it", kind: "review", desc: "desc", prompt: "p", tools: ["git_diff"], profiles: ["review"], enabled: true, pinned: true });
  });
  it("drops rows without a name and defaults unknown kind/profiles", () => {
    const out = parseSkillsFile(JSON.stringify([
      { kind: "workflow" },                       // no name → dropped
      { name: "X", kind: "bogus", profiles: ["nope"] }, // coerced to workflow + ["build"]
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("workflow");
    expect(out[0].profiles).toEqual(["build"]);
  });
  it("returns [] for malformed / non-array input", () => {
    expect(parseSkillsFile("not json")).toEqual([]);
    expect(parseSkillsFile(JSON.stringify({ name: "x" }))).toEqual([]);
    expect(parseSkillsFile("")).toEqual([]);
  });
});

describe("refreshPackagedSkills (#677-style)", () => {
  const seedId = seedSkills()[0].id;

  it("prunes legacy packaged skills and seeds the current packaged set", () => {
    const legacy = def({ id: "open-pr", name: "Open a clean PR", packaged: undefined });
    const out = refreshPackagedSkills([legacy]);
    expect(out.some((s) => s.id === "open-pr")).toBe(false);       // legacy built-in pruned
    expect(out.some((s) => s.id === seedId)).toBe(true);            // current packaged seeded
    expect(out.every((s) => s.packaged)).toBe(true);               // only packaged remain
  });

  it("keeps user-created / imported skills untouched", () => {
    const mine = def({ id: "mine", name: "My skill", source: "imported", packaged: undefined });
    const out = refreshPackagedSkills([mine]);
    expect(out.find((s) => s.id === "mine")).toEqual(mine);
  });

  it("preserves the user's enabled/pinned/projects on a refreshed packaged skill", () => {
    const customized = def({ id: seedId, enabled: false, pinned: true, projects: ["p1"], desc: "stale", packaged: true });
    const refreshed = refreshPackagedSkills([customized]).find((s) => s.id === seedId)!;
    expect(refreshed.enabled).toBe(false);
    expect(refreshed.pinned).toBe(true);
    expect(refreshed.projects).toEqual(["p1"]);
    expect(refreshed.desc).not.toBe("stale");                      // content refreshed from code
  });

  it("prunes a packaged skill removed from code (by the packaged flag)", () => {
    const removed = def({ id: "gone-packaged", packaged: true });
    expect(refreshPackagedSkills([removed]).some((s) => s.id === "gone-packaged")).toBe(false);
  });
});

describe("deriveSkillKpis", () => {
  it("derives total/pinned and invocation-weighted success", () => {
    const k = deriveSkillKpis([
      def({ id: "a", pinned: true, invocations: 100, success: 90 }),
      def({ id: "b", pinned: false, invocations: 100, success: 80 }),
    ]);
    expect(k.total).toBe(2);
    expect(k.pinned).toBe(1);
    expect(k.invWeek).toBe(200);
    expect(k.avgSuccess).toBe(85);
  });
  it("avgSuccess is 0 with no invocations (no divide-by-zero)", () => {
    expect(deriveSkillKpis([def({ invocations: 0 })]).avgSuccess).toBe(0);
  });
});
