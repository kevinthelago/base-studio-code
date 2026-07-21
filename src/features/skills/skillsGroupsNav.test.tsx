import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SkillsWorkspace } from "./";
import { useAppStore } from "@/store";
import { blankSkill } from "./lib/skills";

const ROW = ".skill-row";
const SECTION = ".skill-section";

// A library spanning two kinds + two task groups, with a deliberately ungrouped skill.
const LIB = [
  { ...blankSkill(), id: "w1", name: "Open a clean PR", kind: "workflow" as const, enabled: true },
  { ...blankSkill(), id: "w2", name: "Cut a release", kind: "workflow" as const, enabled: true },
  { ...blankSkill(), id: "sc1", name: "Scaffold a command", kind: "scaffold" as const, enabled: true },
  { ...blankSkill(), id: "r1", name: "Security review", kind: "review" as const, enabled: true },
];
const GROUPS = [
  { id: "rel", name: "Release day", hue: "var(--accent)", skillIds: ["w1", "w2"] },
  { id: "sec", name: "Security sweep", hue: "var(--danger)", skillIds: ["r1"] },
];

const setLib = (groups = GROUPS) =>
  useAppStore.setState({ skills: LIB, skillGroups: groups, sessionSkillGroups: {}, paneSkills: {}, githubToken: "" });

describe("SkillsWorkspace — left-nav Groups section (#skills-groups-nav)", () => {
  beforeEach(() => setLib());

  it("lists a 'Groups' header, an 'All' row, and a row per task group with its member count", () => {
    render(<SkillsWorkspace />);
    expect(screen.getByText("⬡ Groups")).toBeTruthy();
    // both group names show in the left nav (no section headers in list density).
    expect(screen.getByText("Release day")).toBeTruthy();
    expect(screen.getByText("Security sweep")).toBeTruthy();
    // the "All" / clear affordance (the ＋New group button was removed, #2813).
    expect(screen.getByText("All")).toBeTruthy();
    expect(screen.queryByText("＋ New group")).toBeNull();
  });

  it("the top quick-filter bar was removed (no '⬡ Task groups' header)", () => {
    render(<SkillsWorkspace />);
    expect(screen.queryByText("⬡ Task groups")).toBeNull();
  });

  it("selecting a group row filters the library to that group's members; re-clicking clears it", () => {
    const { container } = render(<SkillsWorkspace />);
    fireEvent.click(screen.getByText("Release day"));
    expect(container.querySelectorAll(ROW).length).toBe(2); // w1 + w2
    // re-click clears (single-select toggle) → back to all four.
    fireEvent.click(screen.getByText("Release day"));
    expect(container.querySelectorAll(ROW).length).toBe(4);
  });

  it("the 'All' row clears an active group filter", () => {
    const { container } = render(<SkillsWorkspace />);
    fireEvent.click(screen.getByText("Security sweep"));
    expect(container.querySelectorAll(ROW).length).toBe(1); // r1 only
    fireEvent.click(screen.getByText("All"));
    expect(container.querySelectorAll(ROW).length).toBe(4);
  });

  it("the active group exposes a delete affordance that removes only the group", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SkillsWorkspace />);
    fireEvent.click(screen.getByText("Release day"));
    // the ✕ delete affordance only renders on the active group row.
    const relRow = document.querySelector('[data-group-id="rel"]') as HTMLElement;
    const del = within(relRow).getByTitle("Delete group");
    fireEvent.click(del);
    const st = useAppStore.getState();
    expect(st.skillGroups.find((g) => g.id === "rel")).toBeUndefined();
    expect(st.skillGroups.find((g) => g.id === "sec")).toBeTruthy();
    // skills are NOT deleted.
    expect(st.skills.length).toBe(4);
    confirmSpy.mockRestore();
  });

  it("the Groups section is collapsible — clicking its header hides/reveals the rows (#2803)", () => {
    render(<SkillsWorkspace />);
    expect(screen.getByText("Release day")).toBeTruthy();  // sections default open
    fireEvent.click(screen.getByText("⬡ Groups"));          // collapse
    expect(screen.queryByText("Release day")).toBeNull();
    fireEvent.click(screen.getByText("⬡ Groups"));          // expand again
    expect(screen.getByText("Release day")).toBeTruthy();
  });
});

describe("SkillsWorkspace — distinct grouped / kind sections", () => {
  beforeEach(() => setLib());

  it("Group density renders one bordered section per task group plus an Ungrouped section", () => {
    const { container } = render(<SkillsWorkspace />);
    fireEvent.click(screen.getByText("⬡ Group"));
    const sections = Array.from(container.querySelectorAll(SECTION));
    // Release day, Security sweep, Ungrouped — every skill is grouped except sc1.
    const ids = sections.map((s) => s.getAttribute("data-section-id"));
    expect(ids).toContain("rel");
    expect(ids).toContain("sec");
    expect(ids).toContain("__ungrouped__");
  });

  it("each Group section contains exactly its member rows (rows clearly belong to it)", () => {
    const { container } = render(<SkillsWorkspace />);
    fireEvent.click(screen.getByText("⬡ Group"));
    const rel = container.querySelector(`${SECTION}[data-section-id="rel"]`) as HTMLElement;
    const sec = container.querySelector(`${SECTION}[data-section-id="sec"]`) as HTMLElement;
    expect(within(rel).queryAllByText(/Open a clean PR|Cut a release/).length).toBe(2);
    expect(within(rel).queryByText("Security review")).toBeNull();
    expect(within(sec).queryAllByText("Security review").length).toBe(1);
  });

  it("Kind density renders one section per non-empty kind with the kind's own glyph header", () => {
    const { container } = render(<SkillsWorkspace />);
    fireEvent.click(screen.getByText("⊟ Kind"));
    const ids = Array.from(container.querySelectorAll(SECTION)).map((s) => s.getAttribute("data-section-id"));
    expect(ids).toContain("workflow");
    expect(ids).toContain("scaffold");
    expect(ids).toContain("review");
    // codemod/docs have no members → no section.
    expect(ids).not.toContain("codemod");
    expect(ids).not.toContain("docs");
    // the section header (first child) carries the SECTION's own glyph, not a hardcoded one.
    const wfHeader = container.querySelector(`${SECTION}[data-section-id="workflow"] > div`) as HTMLElement;
    expect(within(wfHeader).getByText("⌁")).toBeTruthy(); // workflow glyph
    const reviewHeader = container.querySelector(`${SECTION}[data-section-id="review"] > div`) as HTMLElement;
    expect(within(reviewHeader).getByText("◇")).toBeTruthy(); // distinct review glyph, proving per-section glyphs
  });

  it("Group density with no task groups shows a hint and a single Ungrouped section", () => {
    setLib([]);
    const { container } = render(<SkillsWorkspace />);
    fireEvent.click(screen.getByText("⬡ Group"));
    expect(screen.getByText(/No task groups yet/)).toBeTruthy();
    const sections = Array.from(container.querySelectorAll(SECTION));
    expect(sections.length).toBe(1);
    expect(sections[0].getAttribute("data-section-id")).toBe("__ungrouped__");
  });
});
