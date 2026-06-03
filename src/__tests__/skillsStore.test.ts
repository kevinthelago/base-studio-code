import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../store";
import { parseSkillsFile, resolveSkills, type SkillDef } from "../lib/skills";

function mk(over: Partial<SkillDef> = {}): SkillDef {
  return {
    id: over.id ?? "s1", name: "A", kind: "workflow", description: "", prompt: "p",
    tools: [], profiles: ["build"], enabled: true, pinned: false, projects: [],
    source: "team", ...over,
  };
}

describe("store · skills slice", () => {
  beforeEach(() => {
    useAppStore.setState({ skills: [mk({ id: "s1", name: "A" })] });
  });

  it("addSkill appends with a generated id", () => {
    useAppStore.getState().addSkill({
      name: "B", kind: "review", description: "", prompt: "p", tools: [],
      profiles: ["review"], enabled: true, pinned: false, projects: [], source: "team",
    });
    const skills = useAppStore.getState().skills;
    expect(skills).toHaveLength(2);
    expect(skills[1].name).toBe("B");
    expect(skills[1].id).toMatch(/^skill_/);
  });

  it("updateSkill patches fields", () => {
    useAppStore.getState().updateSkill("s1", { description: "new" });
    expect(useAppStore.getState().skills[0].description).toBe("new");
  });

  it("toggleSkill flips enabled; toggleSkillPin flips pinned", () => {
    useAppStore.getState().toggleSkill("s1");
    expect(useAppStore.getState().skills[0].enabled).toBe(false);
    useAppStore.getState().toggleSkillPin("s1");
    expect(useAppStore.getState().skills[0].pinned).toBe(true);
  });

  it("setSkillProjects scopes a skill; removeSkill deletes it", () => {
    useAppStore.getState().setSkillProjects("s1", ["p1"]);
    expect(useAppStore.getState().skills[0].projects).toEqual(["p1"]);
    useAppStore.getState().removeSkill("s1");
    expect(useAppStore.getState().skills).toHaveLength(0);
  });

  it("upsertPlannerSkills merges seeds by name (planner channel)", () => {
    const seeds = parseSkillsFile(JSON.stringify([
      { name: "A", prompt: "updated", kind: "codemod" }, // existing → update
      { name: "Fresh", prompt: "new" },                  // new → append
    ]));
    useAppStore.getState().upsertPlannerSkills(seeds);
    const skills = useAppStore.getState().skills;
    expect(skills).toHaveLength(2);
    expect(skills.find(s => s.name === "A")!.prompt).toBe("updated");
    expect(skills.find(s => s.name === "A")!.kind).toBe("codemod");
    expect(skills.find(s => s.name === "Fresh")).toBeTruthy();
  });

  it("deleteLocalProject strips the deleted project from each skill's scope", () => {
    useAppStore.setState({ skills: [mk({ id: "s1", projects: ["proj-x", "proj-y"] })] });
    useAppStore.getState().deleteLocalProject(["proj-x"]);
    expect(useAppStore.getState().skills[0].projects).toEqual(["proj-y"]);
  });

  it("resolveSkills picks enabled + in-scope skills for a project", () => {
    useAppStore.setState({ skills: [
      mk({ id: "g", projects: [] }),
      mk({ id: "p", projects: ["proj-1"] }),
      mk({ id: "off", enabled: false }),
    ]});
    const resolved = resolveSkills(useAppStore.getState().skills, "proj-1");
    expect(resolved.map(s => s.id).sort()).toEqual(["g", "p"]);
  });
});
