import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SkillsScreen } from "../screens/skills";
import { useAppStore } from "../store";
import { blankSkill } from "../lib/skills";
import { SKILL_CATALOG } from "../data/skills";

const SKILL_CARD = ".card.hrow";

describe("SkillsScreen — CRUD", () => {
  beforeEach(() => {
    // A small, deterministic library; no GitHub token so the projects fetch no-ops.
    useAppStore.setState({
      skills: [
        { ...blankSkill(), id: "s1", name: "Open a clean PR", kind: "workflow", enabled: true },
        { ...blankSkill(), id: "s2", name: "Scaffold cmd", kind: "scaffold", enabled: true },
      ],
      paneSkills: {},
      githubToken: "",
    });
  });

  it("'+ new skill' adds a skill to the store and opens its drawer", () => {
    const { container } = render(<SkillsScreen />);
    expect(container.querySelectorAll(SKILL_CARD).length).toBe(2);
    fireEvent.click(screen.getByText("+ new skill"));
    expect(useAppStore.getState().skills).toHaveLength(3);
    // Drawer opens (a name field for the new untitled skill).
    const drawer = container.querySelector(".drawer.on");
    expect(drawer).toBeTruthy();
    expect(within(drawer as HTMLElement).getByText("prompt — the reusable procedure")).toBeTruthy();
  });

  it("editing the drawer name updates the store live", () => {
    const { container } = render(<SkillsScreen />);
    fireEvent.click(container.querySelectorAll(SKILL_CARD)[0]); // open "Open a clean PR"
    const drawer = container.querySelector(".drawer.on") as HTMLElement;
    const nameInput = drawer.querySelector("input.input") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Open a tidy PR" } });
    expect(useAppStore.getState().skills.find(s => s.id === "s1")!.name).toBe("Open a tidy PR");
  });

  it("catalog 'add' appends the catalog skill", () => {
    render(<SkillsScreen />);
    const before = useAppStore.getState().skills.length;
    // The right-rail catalog list renders an "add" button per catalog item.
    const addButtons = screen.getAllByText("add");
    fireEvent.click(addButtons[0]);
    const skills = useAppStore.getState().skills;
    expect(skills).toHaveLength(before + 1);
    expect(skills[skills.length - 1].name).toBe(SKILL_CATALOG[0].name);
  });

  it("drawer 'remove' deletes the skill", () => {
    const { container } = render(<SkillsScreen />);
    fireEvent.click(container.querySelectorAll(SKILL_CARD)[0]);
    fireEvent.click(screen.getByText("remove"));
    expect(useAppStore.getState().skills.find(s => s.id === "s1")).toBeUndefined();
  });

  it("the pin star toggles pinned without opening the drawer", () => {
    const { container } = render(<SkillsScreen />);
    const firstCard = container.querySelectorAll(SKILL_CARD)[0];
    const pin = firstCard.querySelector(".pin-btn") as HTMLElement;
    fireEvent.click(pin);
    expect(useAppStore.getState().skills.find(s => s.id === "s1")!.pinned).toBe(true);
    // Drawer did not open (stopPropagation on the pin click).
    expect(container.querySelector(".drawer.on")).toBeNull();
  });
});
