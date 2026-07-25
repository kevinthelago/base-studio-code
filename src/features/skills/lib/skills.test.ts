import { describe, it, expect } from "vitest";
import {
  seedSkills, resolveSkills, toSkillCfgs, skillSlug, skillContentKey, blankSkill,
  parseSkillsFile, deriveSkillKpis, refreshPackagedSkills,
  sessionSkillState, effectiveSessionSkills, applySessionSkillChoice,
  expandGroups, groupSkillCount, parseSkillGroupsFile, type SkillDef, type SkillGroup,
} from "./skills";

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

  it("seeds the designer AUTHORING skills (a11y + compliance) as workflow, distinct from the *-review audits (#3766)", () => {
    const seed = seedSkills();
    const authoring = seed.filter(s => s.id.startsWith("author-")).map(s => s.id).sort();
    expect(authoring).toEqual(["author-accessible-components", "author-compliant-components"]);
    // Authoring = a build-time procedure (workflow), NOT a post-hoc review — that's the shift-left point.
    expect(seed.filter(s => s.id.startsWith("author-")).every(s => s.kind === "workflow")).toBe(true);
    // The audit twin stays a review: author → audit is the two-sided loop.
    expect(seed.find(s => s.id === "wcag-audit")?.kind).toBe("review");
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

describe("per-session assignment (#1056)", () => {
  const all = [
    def({ id: "g",  enabled: true,  projects: [] }),                 // global
    def({ id: "gp", enabled: true,  projects: [], pinned: true }),   // global + pinned
    def({ id: "p1", enabled: true,  projects: ["proj1"] }),          // this project
    def({ id: "p2", enabled: true,  projects: ["proj2"] }),          // other project
    def({ id: "off", enabled: false, projects: [] }),                // disabled
  ];

  describe("effectiveSessionSkills", () => {
    it("with no override equals resolveSkills (inherited set)", () => {
      const eff = effectiveSessionSkills(all, "proj1").map(s => s.id).sort();
      const res = resolveSkills(all, "proj1").map(s => s.id).sort();
      expect(eff).toEqual(res);
      expect(eff).toEqual(["g", "gp", "p1"]);
    });
    it("an `add` override pulls in an out-of-scope (other-project) skill", () => {
      const eff = effectiveSessionSkills(all, "proj1", { add: ["p2"], remove: [] }).map(s => s.id);
      expect(eff).toContain("p2");
    });
    it("a `remove` override drops an inherited skill", () => {
      const eff = effectiveSessionSkills(all, "proj1", { add: [], remove: ["g"] }).map(s => s.id);
      expect(eff).not.toContain("g");
      expect(eff).toContain("p1");
    });
    it("a disabled skill is never written, even when explicitly added", () => {
      const eff = effectiveSessionSkills(all, "proj1", { add: ["off"], remove: [] }).map(s => s.id);
      expect(eff).not.toContain("off");
    });
  });

  describe("sessionSkillState", () => {
    const state = (id: string, proj: string, o?: { add: string[]; remove: string[] }) =>
      sessionSkillState(all.find(s => s.id === id)!, proj, o);

    it("labels inherited reasons (global / pinned / project / out-of-scope / disabled)", () => {
      expect(state("g", "proj1")).toMatchObject({ on: true, reason: "global", overridden: false });
      expect(state("gp", "proj1")).toMatchObject({ on: true, reason: "pinned" });
      expect(state("p1", "proj1")).toMatchObject({ on: true, reason: "project" });
      expect(state("p2", "proj1")).toMatchObject({ on: false, reason: "out-of-scope", overridden: false });
      expect(state("off", "proj1")).toMatchObject({ on: false, reason: "disabled", overridden: false });
    });
    it("flags a genuine override as added / removed", () => {
      expect(state("p2", "proj1", { add: ["p2"], remove: [] })).toMatchObject({ on: true, reason: "added", overridden: true });
      expect(state("g", "proj1", { add: [], remove: ["g"] })).toMatchObject({ on: false, reason: "removed", overridden: true });
    });
    it("treats a redundant choice (matches inheritance) as NOT overridden", () => {
      // adding an already-in-scope skill keeps its natural reason, not "added"
      expect(state("g", "proj1", { add: ["g"], remove: [] })).toMatchObject({ on: true, reason: "global", overridden: false });
      // removing an already-out-of-scope skill stays "out-of-scope"
      expect(state("p2", "proj1", { add: [], remove: ["p2"] })).toMatchObject({ on: false, reason: "out-of-scope", overridden: false });
    });
  });

  describe("applySessionSkillChoice", () => {
    it("on/off record the deviation; inherit clears it; choices are mutually exclusive", () => {
      let o = applySessionSkillChoice(undefined, "x", "on");
      expect(o).toEqual({ add: ["x"], remove: [] });
      o = applySessionSkillChoice(o, "x", "off");          // flips, never both
      expect(o).toEqual({ add: [], remove: ["x"] });
      o = applySessionSkillChoice(o, "x", "inherit");      // clears
      expect(o).toEqual({ add: [], remove: [] });
    });
  });
});

describe("task groups (#skills-groups)", () => {
  const all = [
    def({ id: "g",  enabled: true,  projects: [] }),
    def({ id: "p2", enabled: true,  projects: ["proj2"] }),   // out of scope for proj1
    def({ id: "off", enabled: false, projects: [] }),         // disabled
  ];
  const groups: SkillGroup[] = [
    { id: "grpA", name: "Release day", hue: "var(--accent)", skillIds: ["p2", "off"] },
    { id: "grpB", name: "Empty", hue: "var(--info)", skillIds: [] },
  ];

  it("expandGroups dedupes member ids across enabled groups; unknown ids contribute nothing", () => {
    expect(expandGroups(["grpA"], groups).sort()).toEqual(["off", "p2"]);
    expect(expandGroups(["grpA", "grpA"], groups).sort()).toEqual(["off", "p2"]); // de-duped
    expect(expandGroups(["nope"], groups)).toEqual([]);
  });

  it("groupSkillCount counts only members that still exist in the library", () => {
    expect(groupSkillCount(groups[0], all)).toBe(2);
    expect(groupSkillCount({ ...groups[0], skillIds: ["p2", "ghost"] }, all)).toBe(1);
  });

  it("a toggled-on group enables an out-of-scope member (reason 'group') but never a disabled one", () => {
    const gids = new Set(expandGroups(["grpA"], groups));
    expect(sessionSkillState(all[1], "proj1", undefined, gids)).toMatchObject({ on: true, reason: "group" });
    expect(sessionSkillState(all[2], "proj1", undefined, gids)).toMatchObject({ on: false, reason: "disabled" });
    const eff = effectiveSessionSkills(all, "proj1", undefined, gids).map(s => s.id);
    expect(eff).toContain("g");    // still inherited (global)
    expect(eff).toContain("p2");   // pulled in by the group
    expect(eff).not.toContain("off");
  });

  it("a per-skill remove override still beats a group-enabled skill", () => {
    const gids = new Set(expandGroups(["grpA"], groups));
    const st = sessionSkillState(all[1], "proj1", { add: [], remove: ["p2"] }, gids);
    expect(st).toMatchObject({ on: false, reason: "removed", overridden: true });
  });

  it("parseSkillGroupsFile resolves member refs by id OR name-slug, defaults the hue, drops nameless rows", () => {
    const lib = [def({ id: "sk1", name: "Open a clean PR" }), def({ id: "sk2", name: "Cut a release" })];
    const out = parseSkillGroupsFile(JSON.stringify([
      { name: "Release", skills: ["sk1", "cut-a-release", "ghost"] }, // id, slug, unknown
      { hue: "x" },                                                   // no name → dropped
    ]), lib);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Release");
    expect(out[0].hue).toBe("var(--accent)");                         // defaulted
    expect(out[0].skillIds.sort()).toEqual(["sk1", "sk2"]);          // resolved + unknown dropped
  });
});

describe("toSkillCfgs", () => {
  it("maps to the backend payload and skips name-less skills", () => {
    const cfgs = toSkillCfgs([def({ name: "Open a clean PR" }), def({ id: "x", name: "***" })]);
    expect(cfgs).toEqual([{ id: "s1", name: "Open a clean PR", description: "d", prompt: "body", tools: ["create_pr"] }]);
  });
});

describe("skillContentKey (#3672)", () => {
  it("is equal for identical authored content, differs when any authored field changes, and ignores user/display state", () => {
    const a = def();
    expect(skillContentKey(a)).toBe(skillContentKey({ ...a }));
    // Each AUTHORED field (the packaged code owns) shifts the key, so a code update re-pushes.
    expect(skillContentKey(a)).not.toBe(skillContentKey({ ...a, name: "Renamed" }));
    expect(skillContentKey(a)).not.toBe(skillContentKey({ ...a, kind: "review" }));
    expect(skillContentKey(a)).not.toBe(skillContentKey({ ...a, source: "imported" }));
    expect(skillContentKey(a)).not.toBe(skillContentKey({ ...a, desc: "changed" }));
    expect(skillContentKey(a)).not.toBe(skillContentKey({ ...a, prompt: "new body" }));
    expect(skillContentKey(a)).not.toBe(skillContentKey({ ...a, tools: [...a.tools, "extra"] }));
    expect(skillContentKey(a)).not.toBe(skillContentKey({ ...a, profiles: ["review"] }));
    // User/display state is NOT part of the key — enabled/pinned/projects/telemetry write through
    // their own mutations, so a toggle never triggers a hydrate re-push (the whole point of #3672).
    expect(skillContentKey(a)).toBe(skillContentKey({
      ...a, id: "whatever", enabled: false, pinned: true, projects: ["p1"],
      invocations: 99, success: 42, avgTokensK: 7, trend: [1, 2, 3],
    }));
  });
});

describe("blankSkill", () => {
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
