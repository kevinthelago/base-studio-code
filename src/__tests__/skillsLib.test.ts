import { describe, it, expect } from "vitest";
import {
  resolveSkills, skillSlug, toSkillCfg, toSkillCfgs, defFromCatalog, blankSkill,
  parseSkillsFile, upsertSkillSeeds, type SkillDef,
} from "../lib/skills";

function mk(over: Partial<SkillDef> = {}): SkillDef {
  return {
    id: over.id ?? "s1", name: "Open a clean PR", kind: "workflow",
    description: "d", prompt: "do the thing", tools: ["create_pr"], profiles: ["build"],
    enabled: true, pinned: false, projects: [], source: "first-party", ...over,
  };
}

describe("resolveSkills", () => {
  it("includes enabled global skills and excludes disabled ones", () => {
    const all = [mk({ id: "a" }), mk({ id: "b", enabled: false })];
    expect(resolveSkills(all, "proj").map(s => s.id)).toEqual(["a"]);
  });

  it("includes a project-scoped skill only for its project", () => {
    const scoped = mk({ id: "x", projects: ["proj-1"] });
    expect(resolveSkills([scoped], "proj-1").map(s => s.id)).toEqual(["x"]);
    expect(resolveSkills([scoped], "proj-2")).toEqual([]);
    // No active project → only globals, never a scoped skill.
    expect(resolveSkills([scoped], "")).toEqual([]);
  });
});

describe("skillSlug", () => {
  it("lowercases, hyphenates, and trims", () => {
    expect(skillSlug("Open a Clean PR!")).toBe("open-a-clean-pr");
    expect(skillSlug("  Scaffold/Tauri  ")).toBe("scaffold-tauri");
  });
  it("never produces an empty slug", () => {
    expect(skillSlug("!!!")).toBe("skill");
  });
});

describe("toSkillCfg / toSkillCfgs", () => {
  it("builds a SKILL.md payload with a slug from the name", () => {
    const cfg = toSkillCfg(mk());
    expect(cfg).toEqual({
      slug: "open-a-clean-pr", name: "Open a clean PR", description: "d",
      tools: ["create_pr"], prompt: "do the thing",
    });
  });

  it("drops skills missing a name or prompt", () => {
    expect(toSkillCfg(mk({ name: "  " }))).toBeNull();
    expect(toSkillCfg(mk({ prompt: "" }))).toBeNull();
  });

  it("dedupes by slug — first writer wins", () => {
    const a = mk({ id: "a", name: "Same Name", prompt: "first" });
    const b = mk({ id: "b", name: "same name", prompt: "second" });
    const cfgs = toSkillCfgs([a, b]);
    expect(cfgs).toHaveLength(1);
    expect(cfgs[0].prompt).toBe("first");
  });
});

describe("defFromCatalog / blankSkill", () => {
  it("expands a known catalog name into a full, enabled, pinned skill", () => {
    const def = defFromCatalog("Open a clean PR");
    expect(def.name).toBe("Open a clean PR");
    expect(def.enabled).toBe(true);
    expect(def.pinned).toBe(true);
    expect(def.prompt.length).toBeGreaterThan(0);
    expect(def.tools).toContain("create_pr");
    expect(def.projects).toEqual([]);
  });

  it("falls back to a blank skill for an unknown name", () => {
    const def = defFromCatalog("Totally Unknown");
    expect(def.name).toBe("Totally Unknown");
    expect(def.prompt).toBe("");
    expect(def.enabled).toBe(false);
  });

  it("blankSkill is disabled, global, and workflow-kind", () => {
    const b = blankSkill();
    expect(b.enabled).toBe(false);
    expect(b.kind).toBe("workflow");
    expect(b.projects).toEqual([]);
  });
});

describe("parseSkillsFile", () => {
  it("parses a valid planner skills.json array", () => {
    const seeds = parseSkillsFile(JSON.stringify([
      { name: "Lint sweep", kind: "review", description: "x", prompt: "p", tools: ["grep"], profiles: ["review"], pinned: true },
      { name: "Bad kind", kind: "nonsense", profiles: ["wat"] },
    ]));
    expect(seeds).toHaveLength(2);
    expect(seeds[0]).toMatchObject({ name: "Lint sweep", kind: "review", pinned: true, enabled: true });
    // Unknown kind defaults to workflow; bad profiles dropped → default ["build"].
    expect(seeds[1].kind).toBe("workflow");
    expect(seeds[1].profiles).toEqual(["build"]);
  });

  it("drops entries with no name", () => {
    expect(parseSkillsFile(JSON.stringify([{ prompt: "no name" }]))).toEqual([]);
  });

  it("returns [] for malformed or non-array input (never throws)", () => {
    expect(parseSkillsFile("not json")).toEqual([]);
    expect(parseSkillsFile(JSON.stringify({ not: "an array" }))).toEqual([]);
    expect(parseSkillsFile("")).toEqual([]);
  });
});

describe("upsertSkillSeeds", () => {
  it("updates an existing skill by name, preserving id/enabled/pinned/projects", () => {
    const existing = [mk({ id: "keep", name: "Lint sweep", enabled: false, pinned: true, projects: ["p1"], prompt: "old" })];
    const seeds = parseSkillsFile(JSON.stringify([{ name: "lint sweep", prompt: "new", kind: "review" }]));
    let n = 0;
    const next = upsertSkillSeeds(existing, seeds, () => `new_${n++}`);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("keep");
    expect(next[0].enabled).toBe(false);    // user-owned, preserved
    expect(next[0].pinned).toBe(true);      // preserved
    expect(next[0].projects).toEqual(["p1"]); // preserved
    expect(next[0].prompt).toBe("new");     // content updated
    expect(next[0].kind).toBe("review");
  });

  it("appends a new skill with a minted id", () => {
    const seeds = parseSkillsFile(JSON.stringify([{ name: "Fresh", prompt: "p" }]));
    const next = upsertSkillSeeds([], seeds, () => "minted");
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("minted");
    expect(next[0].name).toBe("Fresh");
  });
});
