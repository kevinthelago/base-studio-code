import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillsScreen } from "./";
import { useAppStore } from "../../store";
import { blankSkill } from "../../lib/session/skills";

const ROW = ".skill-row";

// A small, deterministic library across kinds so row/facet counts are predictable.
const LIB = [
  { ...blankSkill(), id: "w1", name: "Open a clean PR", kind: "workflow" as const, enabled: true },
  { ...blankSkill(), id: "w2", name: "Cut a release", kind: "workflow" as const, enabled: true },
  { ...blankSkill(), id: "sc1", name: "Scaffold a command", kind: "scaffold" as const, enabled: true },
  { ...blankSkill(), id: "r1", name: "Security review", kind: "review" as const, enabled: true },
];

describe("SkillsScreen — library at scale (#skills-groups)", () => {
  beforeEach(() => {
    useAppStore.setState({ skills: LIB, skillGroups: [], sessionSkillGroups: {}, paneSkills: {}, githubToken: "" });
  });

  it("renders the library as dense rows with a search box and a result count", () => {
    const { container } = render(<SkillsScreen />);
    expect(container.querySelectorAll(ROW).length).toBe(4);
    expect(screen.getByPlaceholderText("Search name, description, tools…")).toBeTruthy();
  });

  it("search narrows the rows", () => {
    const { container } = render(<SkillsScreen />);
    fireEvent.change(screen.getByPlaceholderText("Search name, description, tools…"), { target: { value: "release" } });
    expect(container.querySelectorAll(ROW).length).toBe(1);
  });

  it("a Kind facet filters the rows (and the count reflects it)", () => {
    const { container } = render(<SkillsScreen />);
    fireEvent.click(screen.getByText("workflow")); // the Kind facet option
    expect(container.querySelectorAll(ROW).length).toBe(2); // two workflow skills
  });

  it("the Cards density renders skill cards instead of rows", () => {
    const { container } = render(<SkillsScreen />);
    fireEvent.click(screen.getByText("▦ Cards"));
    expect(container.querySelectorAll(ROW).length).toBe(0);
    expect(container.querySelectorAll(".skill-card").length).toBe(4);
  });

  it("the Group density sections skills, including an Ungrouped bucket", () => {
    useAppStore.setState({ skillGroups: [{ id: "g1", name: "Release day", hue: "var(--accent)", skillIds: ["w1", "w2"] }] });
    render(<SkillsScreen />);
    fireEvent.click(screen.getByText("⬡ Group"));
    // "Release day" appears as both the quick-filter chip and the section header.
    expect(screen.getAllByText("Release day").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Ungrouped")).toBeTruthy();
  });

  it("a task-group chip filters the library to that group's members", () => {
    useAppStore.setState({ skillGroups: [{ id: "g1", name: "Release day", hue: "var(--accent)", skillIds: ["w1", "w2"] }] });
    const { container } = render(<SkillsScreen />);
    // The chip carries the group name + member count.
    fireEvent.click(screen.getByText("Release day"));
    expect(container.querySelectorAll(ROW).length).toBe(2);
  });

  it("switches to the Runs view and shows the empty state with no usage log", () => {
    const { container } = render(<SkillsScreen />);
    fireEvent.click(screen.getByText("Runs"));
    expect(screen.getByText("No runs yet")).toBeTruthy();
    expect(container.querySelectorAll(ROW).length).toBe(0);
  });

  it("the Catalog view has a search box and add buttons", () => {
    render(<SkillsScreen />);
    fireEvent.click(screen.getByText("Catalog"));
    expect(screen.getByPlaceholderText("Search the catalog…")).toBeTruthy();
    expect(screen.getAllByText("add to library").length).toBeGreaterThan(0);
  });
});
