import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";
import { blankSkill, parseSkillsFile } from "../lib/session/skills";

describe("skills store slice", () => {
  beforeEach(() => {
    useAppStore.setState({ skills: [], paneSkills: {} });
  });

  it("addSkill appends with a generated id and returns it", () => {
    const id = useAppStore.getState().addSkill({ ...blankSkill(), name: "Ship it" });
    const skills = useAppStore.getState().skills;
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe(id);
    expect(skills[0].name).toBe("Ship it");
  });

  it("updateSkill patches, toggleSkill flips enabled, toggleSkillPin flips pinned", () => {
    const id = useAppStore.getState().addSkill({ ...blankSkill(), name: "X", enabled: false, pinned: false });
    useAppStore.getState().updateSkill(id, { desc: "now described" });
    expect(useAppStore.getState().skills[0].desc).toBe("now described");
    useAppStore.getState().toggleSkill(id);
    expect(useAppStore.getState().skills[0].enabled).toBe(true);
    useAppStore.getState().toggleSkillPin(id);
    expect(useAppStore.getState().skills[0].pinned).toBe(true);
  });

  it("setSkillProjects scopes, removeSkill deletes", () => {
    const id = useAppStore.getState().addSkill({ ...blankSkill(), name: "X" });
    useAppStore.getState().setSkillProjects(id, ["proj1", "proj2"]);
    expect(useAppStore.getState().skills[0].projects).toEqual(["proj1", "proj2"]);
    useAppStore.getState().removeSkill(id);
    expect(useAppStore.getState().skills).toHaveLength(0);
  });

  it("upsertSkills adds new and refines existing by name-slug", () => {
    useAppStore.getState().addSkill({ ...blankSkill(), name: "Open a clean PR", desc: "old" });
    useAppStore.getState().upsertSkills([
      { ...blankSkill(), name: "Open a clean PR", desc: "refined" }, // matches by slug → update
      { ...blankSkill(), name: "Brand new skill", desc: "new" },     // no match → insert
    ]);
    const skills = useAppStore.getState().skills;
    expect(skills).toHaveLength(2);
    expect(skills.find(s => s.name === "Open a clean PR")!.desc).toBe("refined");
    expect(skills.some(s => s.name === "Brand new skill")).toBe(true);
  });

  it("ingests a planner-shaped skills.json into the library, refining on re-emit (#1086)", () => {
    // The shape the planner writes to skills.json — an array of skill objects.
    const skillsJson = JSON.stringify([
      { name: "Virtual mountain weathering", kind: "docs", desc: "Procedural erosion grounded in recent papers.", prompt: "Apply hydraulic + thermal erosion…", tools: ["read_file"] },
    ]);
    useAppStore.getState().upsertSkills(parseSkillsFile(skillsJson));
    let skills = useAppStore.getState().skills;
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "Virtual mountain weathering", kind: "docs", enabled: true, pinned: true });
    expect(skills[0].prompt).toContain("erosion");

    // Re-emitting the same skill (refined) updates in place by name-slug — not duplicated.
    useAppStore.getState().upsertSkills(parseSkillsFile(
      JSON.stringify([{ name: "Virtual mountain weathering", kind: "docs", desc: "v2", prompt: "Refined." }]),
    ));
    skills = useAppStore.getState().skills;
    expect(skills).toHaveLength(1);
    expect(skills[0].desc).toBe("v2");
  });

  it("deleteLocalProject strips the deleted key from every skill's scope", () => {
    const id = useAppStore.getState().addSkill({ ...blankSkill(), name: "X" });
    useAppStore.getState().setSkillProjects(id, ["keep", "drop"]);
    useAppStore.getState().deleteLocalProject(["drop"]);
    expect(useAppStore.getState().skills[0].projects).toEqual(["keep"]);
  });
});
