import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillsScreen } from "../screens/skills";
import { SKILLS, SKILL_KPIS } from "../data/skills";

// Skill cards carry both `card` and `hrow`; the right-rail panels are `card`
// only and the catalog rows are `hrow` only — so `.card.hrow` selects exactly
// the skill cards in the main grid.
const SKILL_CARD = ".card.hrow";
const scaffoldCount = SKILLS.filter(s => s.kind === "scaffold").length;

/** The kind-filter segmented control buttons (all / workflow / scaffold / …). */
function segButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(".seg button"));
}

describe("SkillsScreen", () => {
  it("renders the header, KPIs, and the skill library", () => {
    const { container } = render(<SkillsScreen />);
    expect(screen.getByRole("heading", { name: "Skills" })).toBeTruthy();
    // KPI + digest figures come from the derived SKILL_KPIS.
    expect(screen.getAllByText(String(SKILL_KPIS.invToday)).length).toBeGreaterThan(0);
    // Right-rail panels are present.
    expect(screen.getByText("Most invoked")).toBeTruthy();
    expect(screen.getByText("Success by kind")).toBeTruthy();
    expect(screen.getByText("Add a skill")).toBeTruthy();
    // One card per skill in the library.
    expect(container.querySelectorAll(SKILL_CARD).length).toBe(SKILLS.length);
  });

  it("filters the grid by kind and restores it via 'all'", () => {
    const { container } = render(<SkillsScreen />);
    expect(container.querySelectorAll(SKILL_CARD).length).toBe(SKILLS.length);

    const scaffold = segButtons(container).find(b => b.textContent === "scaffold")!;
    fireEvent.click(scaffold);
    expect(container.querySelectorAll(SKILL_CARD).length).toBe(scaffoldCount);
    expect(scaffold.className).toContain("on");

    const all = segButtons(container).find(b => b.textContent === "all")!;
    fireEvent.click(all);
    expect(container.querySelectorAll(SKILL_CARD).length).toBe(SKILLS.length);
  });
});
