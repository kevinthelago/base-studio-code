import { describe, it, expect } from "vitest";
import { buildSkillLibrary } from "./blueprintSkills";
import { addSkill, removeSkill, mkStageSection } from "./blueprintEdit";
import type { SkillDef } from "@/features/skills/lib/skills";
import type { BlueprintStage } from "../stages/blueprints";

const skillDef = (id: string, name: string): SkillDef => ({
  id, name, kind: "procedure", source: "local", desc: `${name} desc`, prompt: "", tools: [], profiles: [],
  projects: [], enabled: true, pinned: false, invocations: 0, success: 0, avgTokensK: 0, lastUsed: "", trend: [],
} as unknown as SkillDef);

describe("blueprintSkills library (#636)", () => {
  const lib = buildSkillLibrary([skillDef("s1", "API design"), skillDef("s2", "House style")]);

  it("lists skills as pickable items", () => {
    expect(lib).toEqual([
      { id: "s1", name: "API design", kind: "skill", desc: "API design desc" },
      { id: "s2", name: "House style", kind: "skill", desc: "House style desc" },
    ]);
  });
});

describe("blueprintEdit skill helpers (#636)", () => {
  const base = (): BlueprintStage[] => [mkStageSection("api")];
  it("addSkill attaches (no dupes); removeSkill detaches", () => {
    let s = base();
    s = addSkill(s, s[0].uid, "s1");
    s = addSkill(s, s[0].uid, "s1"); // dupe ignored
    expect(s[0].skills).toEqual(["s1"]);
    s = addSkill(s, s[0].uid, "k1");
    expect(s[0].skills).toEqual(["s1", "k1"]);
    s = removeSkill(s, s[0].uid, "s1");
    expect(s[0].skills).toEqual(["k1"]);
  });
});
