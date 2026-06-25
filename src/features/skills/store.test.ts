import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";
import { blankSkill, parseSkillsFile } from "./lib/skills";

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

describe("per-session skill overrides (#1056)", () => {
  beforeEach(() => {
    useAppStore.setState({ sessionSkillOverrides: {} });
  });
  const SESS = "proj:checkout"; // a stable session identity id

  it("setSessionSkill records on/off choices keyed by session", () => {
    useAppStore.getState().setSessionSkill(SESS, "sk1", "on");
    useAppStore.getState().setSessionSkill(SESS, "sk2", "off");
    expect(useAppStore.getState().sessionSkillOverrides[SESS]).toEqual({ add: ["sk1"], remove: ["sk2"] });
  });

  it("re-choosing the same skill flips it (never in both lists)", () => {
    useAppStore.getState().setSessionSkill(SESS, "sk1", "on");
    useAppStore.getState().setSessionSkill(SESS, "sk1", "off");
    expect(useAppStore.getState().sessionSkillOverrides[SESS]).toEqual({ add: [], remove: ["sk1"] });
  });

  it("prunes the session entry once its last override is cleared (inherit)", () => {
    useAppStore.getState().setSessionSkill(SESS, "sk1", "on");
    useAppStore.getState().setSessionSkill(SESS, "sk1", "inherit");
    expect(useAppStore.getState().sessionSkillOverrides[SESS]).toBeUndefined();
  });

  it("resetSessionSkills drops every override for that session only", () => {
    useAppStore.getState().setSessionSkill(SESS, "sk1", "on");
    useAppStore.getState().setSessionSkill("proj:other", "sk9", "off");
    useAppStore.getState().resetSessionSkills(SESS);
    expect(useAppStore.getState().sessionSkillOverrides[SESS]).toBeUndefined();
    expect(useAppStore.getState().sessionSkillOverrides["proj:other"]).toEqual({ add: [], remove: ["sk9"] });
  });

  it("resetSessionSkills also clears the session's group toggles", () => {
    useAppStore.getState().setSessionSkillGroup(SESS, "grpA", true);
    useAppStore.getState().setSessionSkill(SESS, "sk1", "on");
    useAppStore.getState().resetSessionSkills(SESS);
    expect(useAppStore.getState().sessionSkillGroups[SESS]).toBeUndefined();
  });
});

describe("task groups (#skills-groups)", () => {
  beforeEach(() => {
    useAppStore.setState({ skillGroups: [], sessionSkillGroups: {} });
  });

  it("addSkillGroup creates an empty group; toggleSkillGroupMember adds then removes a member", () => {
    const id = useAppStore.getState().addSkillGroup("Release day", "var(--accent)");
    expect(useAppStore.getState().skillGroups).toHaveLength(1);
    useAppStore.getState().toggleSkillGroupMember(id, "sk1");
    expect(useAppStore.getState().skillGroups[0].skillIds).toEqual(["sk1"]);
    useAppStore.getState().toggleSkillGroupMember(id, "sk1");
    expect(useAppStore.getState().skillGroups[0].skillIds).toEqual([]);
  });

  it("removeSkillGroup deletes it and prunes it from every session toggle", () => {
    const id = useAppStore.getState().addSkillGroup("X");
    useAppStore.getState().setSessionSkillGroup("sessA", id, true);
    useAppStore.getState().removeSkillGroup(id);
    expect(useAppStore.getState().skillGroups).toHaveLength(0);
    expect(useAppStore.getState().sessionSkillGroups["sessA"]).toBeUndefined(); // dangling ref pruned
  });

  it("upsertSkillGroups refines by name-slug and inserts new (planner channel)", () => {
    useAppStore.getState().addSkillGroup("Release day");
    useAppStore.getState().upsertSkillGroups([
      { name: "Release day", hue: "var(--danger)", skillIds: ["a"] }, // matches by slug → update
      { name: "Security sweep", hue: "var(--danger)", skillIds: ["b"] }, // new
    ]);
    const g = useAppStore.getState().skillGroups;
    expect(g).toHaveLength(2);
    expect(g.find((x) => x.name === "Release day")!.skillIds).toEqual(["a"]);
  });

  it("ensureSessionGroup creates the per-project session group with a fixed id + name (#1419)", () => {
    useAppStore.getState().ensureSessionGroup("grp-session-acme", "Acme CRM");
    const g = useAppStore.getState().skillGroups;
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ id: "grp-session-acme", name: "Acme CRM", skillIds: [] });
  });

  it("ensureSessionGroup renames in place on a title change WITHOUT clobbering members (#1419)", () => {
    useAppStore.getState().ensureSessionGroup("grp-session-acme", "Acme CRM");
    // The planner paired a skill into it (as `bsc-skill add --group` would).
    useAppStore.getState().toggleSkillGroupMember("grp-session-acme", "sk1");
    // Re-ensure with a new title (the project was renamed) — must keep the member, just rename.
    useAppStore.getState().ensureSessionGroup("grp-session-acme", "Acme Platform");
    const g = useAppStore.getState().skillGroups;
    expect(g).toHaveLength(1); // not duplicated
    expect(g[0]).toMatchObject({ id: "grp-session-acme", name: "Acme Platform", skillIds: ["sk1"] });
  });

  it("setSessionSkillGroup toggles a group on/off per session and prunes an emptied entry", () => {
    useAppStore.getState().setSessionSkillGroup("sessA", "g1", true);
    useAppStore.getState().setSessionSkillGroup("sessA", "g2", true);
    expect(useAppStore.getState().sessionSkillGroups["sessA"]).toEqual(["g1", "g2"]);
    useAppStore.getState().setSessionSkillGroup("sessA", "g1", false);
    useAppStore.getState().setSessionSkillGroup("sessA", "g2", false);
    expect(useAppStore.getState().sessionSkillGroups["sessA"]).toBeUndefined();
  });
});
