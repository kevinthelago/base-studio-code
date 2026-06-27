import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SkillsScreen } from "./";
import { useAppStore } from "@/store";
import { blankSkill, parseSkillsFile } from "./lib/skills";

const LIB = [
  { ...blankSkill(), id: "w1", name: "Open a clean PR", kind: "workflow" as const, enabled: true },
  { ...blankSkill(), id: "w2", name: "Cut a release", kind: "workflow" as const, enabled: true },
];

/** Find the page-header (TabBar) right-slot action area, scoping queries off the screen root
 *  so we don't collide with the empty-state's own "+ new skill" button. */
function header(container: HTMLElement): HTMLElement {
  return container.querySelector(".skills-screen > *") as HTMLElement; // the TabBar is the first child
}

describe("SkillsScreen — page-header actions (import + '+ skill')", () => {
  beforeEach(() => {
    useAppStore.setState({ skills: LIB, skillGroups: [], sessionSkillGroups: {}, paneSkills: {}, githubToken: "" });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("library mode shows 'import' + '+ skill' in the page header alongside the github-sync badge", () => {
    const { container } = render(<SkillsScreen />);
    const head = header(container);
    expect(within(head).getByText("import")).toBeTruthy();
    expect(within(head).getByText("+ skill")).toBeTruthy();
    expect(within(head).getByText("● github sync")).toBeTruthy();
  });

  it("the header buttons do NOT appear on the Runs tab (only the sync badge remains)", () => {
    const { container } = render(<SkillsScreen />);
    fireEvent.click(screen.getByText("Runs"));
    const head = header(container);
    expect(within(head).queryByText("import")).toBeNull();
    expect(within(head).queryByText("+ skill")).toBeNull();
    expect(within(head).getByText("● github sync")).toBeTruthy();
  });

  it("the header buttons do NOT appear off the Library tab", () => {
    const { container } = render(<SkillsScreen />);
    fireEvent.click(screen.getByText("Runs"));
    const head = header(container);
    expect(within(head).queryByText("import")).toBeNull();
    expect(within(head).queryByText("+ skill")).toBeNull();
  });

  it("'+ skill' opens the draft drawer without creating a skill", () => {
    const { container } = render(<SkillsScreen />);
    fireEvent.click(within(header(container)).getByText("+ skill"));
    const drawer = container.querySelector(".pane-drawer.on") as HTMLElement;
    expect(drawer).toBeTruthy();
    expect(within(drawer).getByText("procedure — SKILL.md body")).toBeTruthy();
    expect(useAppStore.getState().skills).toHaveLength(2); // draft not committed
  });

  it("'import' triggers the hidden JSON file input; a valid file upserts via parseSkillsFile", async () => {
    const { container } = render(<SkillsScreen />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.style.display).toBe("none");

    // The header "import" button clicks the hidden input.
    const clickSpy = vi.spyOn(input, "click").mockImplementation(() => {});
    fireEvent.click(within(header(container)).getByText("import"));
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();

    // Simulate the file pick → importSkills(file) reads + parses + upserts.
    const payload = JSON.stringify([{ name: "Imported skill", kind: "workflow", desc: "from a file" }]);
    expect(parseSkillsFile(payload).length).toBe(1); // sanity: the wire format parses
    const file = new File([payload], "skills.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      const names = useAppStore.getState().skills.map((s) => s.name);
      expect(names).toContain("Imported skill");
    });
  });
});
