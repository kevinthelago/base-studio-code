import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SkillsScreen } from "./";
import { useAppStore } from "@/store";
import { blankSkill } from "./lib/skills";

const ROW = ".skill-row"; // the redesign's dense list rows (default density)

describe("SkillsScreen — CRUD", () => {
  beforeEach(() => {
    // A small, deterministic library; no GitHub token so the projects fetch no-ops.
    useAppStore.setState({
      skills: [
        { ...blankSkill(), id: "s1", name: "Open a clean PR", kind: "workflow", enabled: true },
        { ...blankSkill(), id: "s2", name: "Scaffold cmd", kind: "scaffold", enabled: true },
      ],
      paneSkills: {}, skillGroups: [], sessionSkillGroups: {}, githubToken: "",
    });
  });

  it("'+ new skill' (empty state) opens a draft drawer without creating; 'done' commits it", () => {
    // The toolbar import/+skill buttons were removed (#…); the remaining draft entry point is the
    // empty-state "+ new skill", shown when no skills match.
    useAppStore.setState({ skills: [] });
    const { container } = render(<SkillsScreen />);
    fireEvent.click(screen.getByText("+ new skill"));
    const drawer = container.querySelector(".drawer.on") as HTMLElement;
    expect(drawer).toBeTruthy();
    expect(within(drawer).getByText("procedure — SKILL.md body")).toBeTruthy();
    expect(useAppStore.getState().skills).toHaveLength(0);  // nothing added yet (draft)
    const done = within(drawer).getByText("done") as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.change(drawer.querySelector("input.input") as HTMLInputElement, { target: { value: "My new skill" } });
    fireEvent.click(within(drawer).getByText("done"));
    const skills = useAppStore.getState().skills;
    expect(skills).toHaveLength(1);
    expect(skills[skills.length - 1].name).toBe("My new skill");
  });

  it("'+ new skill' then 'cancel' creates nothing", () => {
    useAppStore.setState({ skills: [] });
    const { container } = render(<SkillsScreen />);
    fireEvent.click(screen.getByText("+ new skill"));
    const drawer = container.querySelector(".drawer.on") as HTMLElement;
    fireEvent.click(within(drawer).getByText("cancel"));
    expect(useAppStore.getState().skills).toHaveLength(0);
    expect(container.querySelector(".drawer.on")).toBeNull();
  });

  it("opening a row and editing the name updates the store live", () => {
    const { container } = render(<SkillsScreen />);
    fireEvent.click(container.querySelector(`${ROW}[data-skill-id="s1"]`) as HTMLElement);
    const drawer = container.querySelector(".drawer.on") as HTMLElement;
    fireEvent.change(drawer.querySelector("input.input") as HTMLInputElement, { target: { value: "Open a tidy PR" } });
    expect(useAppStore.getState().skills.find((s) => s.id === "s1")!.name).toBe("Open a tidy PR");
  });

  it("drawer 'remove' deletes the skill", () => {
    const { container } = render(<SkillsScreen />);
    fireEvent.click(container.querySelector(`${ROW}[data-skill-id="s1"]`) as HTMLElement);
    fireEvent.click(screen.getByText("remove"));
    expect(useAppStore.getState().skills.find((s) => s.id === "s1")).toBeUndefined();
  });

  it("the pin star toggles pinned without opening the drawer", () => {
    const { container } = render(<SkillsScreen />);
    const row = container.querySelector(`${ROW}[data-skill-id="s1"]`) as HTMLElement;
    fireEvent.click(row.querySelector(".pin-btn") as HTMLElement);
    expect(useAppStore.getState().skills.find((s) => s.id === "s1")!.pinned).toBe(true);
    expect(container.querySelector(".drawer.on")).toBeNull();  // stopPropagation kept it closed
  });

  it("creating a task group and a skill toggles membership from the drawer", () => {
    const { container } = render(<SkillsScreen />);
    const gid = useAppStore.getState().addSkillGroup("Release day");
    fireEvent.click(container.querySelector(`${ROW}[data-skill-id="s1"]`) as HTMLElement);
    const drawer = container.querySelector(".drawer.on") as HTMLElement;
    fireEvent.click(within(drawer).getByText(/⬡ Release day/));
    expect(useAppStore.getState().skillGroups.find((g) => g.id === gid)!.skillIds).toContain("s1");
  });
});
