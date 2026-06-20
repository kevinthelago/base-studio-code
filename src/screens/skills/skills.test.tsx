import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillsScreen } from "./";
import { SKILLS, SKILL_CATALOG } from "../../data/skills";

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
    // KPI row is present (values derive from real telemetry — 0 with no usage log).
    expect(screen.getByText("invocations · today")).toBeTruthy();
    expect(screen.getByText("avg success")).toBeTruthy();
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

  it("switches to the Runs view, replacing the library grid with the invocations panel", () => {
    const { container } = render(<SkillsScreen />);
    fireEvent.click(screen.getByText("Runs"));
    // The runs panel renders; no usage log in tests → the empty state.
    expect(screen.getByText("Invocations")).toBeTruthy();
    expect(screen.getByText("No runs yet")).toBeTruthy();
    // The library skill grid is no longer mounted.
    expect(container.querySelectorAll(SKILL_CARD).length).toBe(0);
  });

  it("switches to the Catalog view with a search box and add buttons", () => {
    const { container } = render(<SkillsScreen />);
    fireEvent.click(screen.getByText("Catalog"));
    expect(screen.getByPlaceholderText("Search the catalog…")).toBeTruthy();
    expect(screen.getByText(new RegExp(`of ${SKILL_CATALOG.length} skills`))).toBeTruthy();
    // Every catalog entry offers an add (or already-added) action.
    expect(screen.getAllByText(/add to library|✓ added/).length).toBe(SKILL_CATALOG.length);
    // Not the library grid.
    expect(container.querySelectorAll(SKILL_CARD).length).toBe(0);
  });

  it("filters the catalog by the search query", () => {
    render(<SkillsScreen />);
    fireEvent.click(screen.getByText("Catalog"));
    const search = screen.getByPlaceholderText("Search the catalog…");
    fireEvent.change(search, { target: { value: SKILL_CATALOG[0].name } });
    expect(screen.getByText(SKILL_CATALOG[0].name)).toBeTruthy();
    expect(screen.getByText(new RegExp(`of ${SKILL_CATALOG.length} skills`))).toBeTruthy();
  });
});
