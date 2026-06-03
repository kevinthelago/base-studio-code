import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../store";
import { blankSkill } from "../lib/skills";

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

  it("deleteLocalProject strips the deleted key from every skill's scope", () => {
    const id = useAppStore.getState().addSkill({ ...blankSkill(), name: "X" });
    useAppStore.getState().setSkillProjects(id, ["keep", "drop"]);
    useAppStore.getState().deleteLocalProject(["drop"]);
    expect(useAppStore.getState().skills[0].projects).toEqual(["keep"]);
  });
});
