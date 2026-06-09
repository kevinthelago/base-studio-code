import { describe, it, expect } from "vitest";
import { resolveSkillContent, buildSkillContext } from "../screens/projects/blueprintSkills";
import { mkStageSection } from "../screens/projects/blueprintEdit";
import type { SkillDef } from "../lib/skills";
import type { KbBlock } from "../data/mock";
import type { Blueprint } from "../screens/projects/blueprints";

const skill = (id: string, name: string, prompt: string): SkillDef => ({
  id, name, kind: "procedure", source: "local", desc: "", prompt, tools: [], profiles: [],
  projects: [], enabled: true, pinned: false, invocations: 0, success: 0, avgTokensK: 0, lastUsed: "", trend: [],
} as unknown as SkillDef);
const kb = (id: string, title: string, content: string): KbBlock => ({ id, title, tags: [], updated: "", lines: 1, content });

const SKILLS = [skill("s1", "API design", "Prefer REST; version every endpoint.")];
const KB = [kb("k1", "House style", "2-space indent; no default exports.")];

describe("resolveSkillContent (#636 slice b)", () => {
  it("pulls content from skills (prompt) + kb (body), skipping unknown ids", () => {
    const out = resolveSkillContent(["s1", "ghost", "k1"], SKILLS, KB);
    expect(out).toEqual([
      { name: "API design", kind: "skill", content: "Prefer REST; version every endpoint." },
      { name: "House style", kind: "kb", content: "2-space indent; no default exports." },
    ]);
  });
});

describe("buildSkillContext (#636 slice b)", () => {
  const bp = (over: Partial<Blueprint>): Blueprint => ({ id: "b", name: "B", desc: "", sections: [], ...over });

  it("renders project-wide + per-stage attached skills with their content", () => {
    const api = { ...mkStageSection("api"), skills: ["s1"] };
    const doc = buildSkillContext(bp({ skills: ["k1"], sections: [api] }), SKILLS, KB);
    expect(doc).toMatch(/# Attached skills & knowledge/);
    expect(doc).toMatch(/## Project-wide[\s\S]*House style[\s\S]*2-space indent/);
    expect(doc).toMatch(/## .* stage[\s\S]*API design[\s\S]*Prefer REST/);
  });

  it("returns empty string when nothing is attached", () => {
    expect(buildSkillContext(bp({ sections: [mkStageSection("api")] }), SKILLS, KB)).toBe("");
  });
});
