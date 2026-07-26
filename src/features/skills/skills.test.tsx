import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SkillsWorkspace } from "./";
import { useAppStore } from "@/store";
import { resetPageTabs } from "@/test/storeReset";
import { blankSkill } from "./lib/skills";

const ROW = ".skill-row";

// A small, deterministic library across kinds so row/facet counts are predictable.
const LIB = [
  { ...blankSkill(), id: "w1", name: "Open a clean PR", kind: "workflow" as const, enabled: true },
  { ...blankSkill(), id: "w2", name: "Cut a release", kind: "workflow" as const, enabled: true },
  { ...blankSkill(), id: "sc1", name: "Scaffold a command", kind: "scaffold" as const, enabled: true },
  { ...blankSkill(), id: "r1", name: "Security review", kind: "review" as const, enabled: true },
];

describe("SkillsWorkspace — library at scale (#skills-groups)", () => {
  beforeEach(() => {
    // #3836: several tests below click a page tab, which PERSISTS the selection in the store —
    // without this reset a later test renders that tab's page instead of the default one.
    resetPageTabs();
    useAppStore.setState({ skills: LIB, skillGroups: [], sessionSkillGroups: {}, paneSkills: {}, githubToken: "" });
  });

  it("renders the library as dense rows with a search box and a result count", () => {
    const { container } = render(<SkillsWorkspace />);
    expect(container.querySelectorAll(ROW).length).toBe(4);
    expect(screen.getByPlaceholderText("Search name, description, tools…")).toBeTruthy();
  });

  it("leads the header with search and shows no KPI digest, but keeps the fleet digest reachable (#3854)", () => {
    render(<SkillsWorkspace />);
    // The header's primary control.
    expect(screen.getByPlaceholderText("Search name, description, tools…")).toBeInTheDocument();
    // The always-on KPI strip that used to own that slot is gone (4 skills seeded, so "4 skills" would
    // have rendered if it were still there).
    expect(screen.queryByText(/\d+ skills/)).toBeNull();
    expect(screen.queryByText(/avg success/)).toBeNull();
    // …but the PANEL those numbers fronted is still one click away — removing the strip must not have
    // removed the only way in.
    const toggle = screen.getByRole("button", { name: /Fleet digest/i });
    expect(toggle).toBeInTheDocument();
    fireEvent.click(toggle);
    // "Most invoked" is also a Sort option, so anchor on a tile only the PANEL renders.
    expect(screen.getByText("Never run")).toBeInTheDocument();
    expect(screen.getByText("Invoked 7d")).toBeInTheDocument();
  });

  it("search narrows the rows", () => {
    const { container } = render(<SkillsWorkspace />);
    fireEvent.change(screen.getByPlaceholderText("Search name, description, tools…"), { target: { value: "release" } });
    expect(container.querySelectorAll(ROW).length).toBe(1);
  });

  it("a Kind facet filters the rows (and the count reflects it)", () => {
    const { container } = render(<SkillsWorkspace />);
    fireEvent.click(screen.getByText("workflow")); // the Kind facet option
    expect(container.querySelectorAll(ROW).length).toBe(2); // two workflow skills
  });

  it("the Cards density renders skill cards instead of rows", () => {
    const { container } = render(<SkillsWorkspace />);
    fireEvent.click(screen.getByText("▦ Cards"));
    expect(container.querySelectorAll(ROW).length).toBe(0);
    expect(container.querySelectorAll(".skill-card").length).toBe(4);
  });

  it("the Group density sections skills, including an Ungrouped bucket", () => {
    useAppStore.setState({ skillGroups: [{ id: "g1", name: "Release day", hue: "var(--accent)", skillIds: ["w1", "w2"] }] });
    render(<SkillsWorkspace />);
    fireEvent.click(screen.getByText("⬡ Group"));
    // "Release day" appears as both the left-nav Groups row and the section header.
    expect(screen.getAllByText("Release day").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Ungrouped")).toBeTruthy();
  });

  it("a left-nav group row filters the library to that group's members", () => {
    useAppStore.setState({ skillGroups: [{ id: "g1", name: "Release day", hue: "var(--accent)", skillIds: ["w1", "w2"] }] });
    const { container } = render(<SkillsWorkspace />);
    // In list density "Release day" only renders in the left-nav Groups section.
    fireEvent.click(screen.getByText("Release day"));
    expect(container.querySelectorAll(ROW).length).toBe(2);
  });

  it("switches to the Runs view and shows the empty state with no usage log", async () => {
    const { container } = render(<SkillsWorkspace />);
    fireEvent.click(screen.getByText("Runs"));
    // The empty state renders only after the first telemetry poll returns (#2245) — until then a
    // loading skeleton stands in, so wait for the poll to settle.
    expect(await screen.findByText("No runs yet")).toBeTruthy();
    expect(container.querySelectorAll(ROW).length).toBe(0);
  });

});
