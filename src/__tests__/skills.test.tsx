import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SkillsScreen } from "../screens/skills";
import { SKILL_CATALOG } from "../data/skills";
import { useAppStore } from "../store";
import type { SkillDef } from "../lib/skills";

const SEED: SkillDef[] = [
  { id: "k1", name: "Open a clean PR", kind: "workflow", description: "pr helper", prompt: "do", tools: ["create_pr"], profiles: ["build"], enabled: true, pinned: true, projects: [], source: "first-party" },
  { id: "k2", name: "Security review pass", kind: "review", description: "sec sweep", prompt: "scan", tools: ["grep"], profiles: ["review"], enabled: false, pinned: false, projects: [], source: "first-party" },
];

/** The main body (grid / catalog / runs), excluding the right rail which can list
 *  the same skill names under "Add a skill". */
function body(container: HTMLElement): HTMLElement {
  return container.querySelector(".sk-body") as HTMLElement;
}

describe("SkillsScreen", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockResolvedValue(null); // read_skill_log → null → empty log
    useAppStore.setState({ skills: SEED.map(s => ({ ...s })), githubToken: "" });
  });

  it("renders the library with the seeded skills from the store", () => {
    const { container } = render(<SkillsScreen />);
    expect(within(body(container)).getByText("Open a clean PR")).toBeTruthy();
    expect(within(body(container)).getByText("Security review pass")).toBeTruthy();
  });

  it("filters the grid by kind", () => {
    const { container } = render(<SkillsScreen />);
    const reviewBtn = within(container.querySelector(".sk-filter") as HTMLElement).getByText("review");
    fireEvent.click(reviewBtn);
    expect(within(body(container)).queryByText("Open a clean PR")).toBeNull();
    expect(within(body(container)).getByText("Security review pass")).toBeTruthy();
  });

  it("adds a catalog item to the store and opens it in the drawer", () => {
    const { container } = render(<SkillsScreen />);
    const before = useAppStore.getState().skills.length;
    fireEvent.click(container.querySelectorAll(".sk-modestrip .sk-m")[2]); // Catalog
    const card = within(body(container)).getByText(SKILL_CATALOG[1].name).closest(".sk-cat-card") as HTMLElement;
    fireEvent.click(within(card).getByText("add"));
    expect(useAppStore.getState().skills.length).toBe(before + 1);
    expect((container.querySelector(".sk-drawer") as HTMLElement).className).toContain("on");
  });

  it("opens the drawer on a card click and removes the skill", () => {
    const { container } = render(<SkillsScreen />);
    fireEvent.click(within(body(container)).getByText("Open a clean PR"));
    const drawer = container.querySelector(".sk-drawer") as HTMLElement;
    expect(drawer.className).toContain("on");
    fireEvent.click(within(drawer).getByText("remove"));
    expect(useAppStore.getState().skills.some(s => s.id === "k1")).toBe(false);
    expect((container.querySelector(".sk-drawer") as HTMLElement).className).not.toContain("on");
  });

  it("toggles a skill's enabled state from the drawer", () => {
    const { container } = render(<SkillsScreen />);
    fireEvent.click(within(body(container)).getByText("Security review pass"));
    const drawer = container.querySelector(".sk-drawer") as HTMLElement;
    // The disabled skill shows an off toggle; clicking it enables it in the store.
    const toggle = within(drawer).getAllByText("disabled")[0].previousElementSibling as HTMLElement;
    fireEvent.click(toggle);
    expect(useAppStore.getState().skills.find(s => s.id === "k2")!.enabled).toBe(true);
  });

  it("defaults to the catalog and shows an empty state when no skills exist", () => {
    useAppStore.setState({ skills: [] });
    const { container } = render(<SkillsScreen />);
    expect(container.querySelectorAll(".sk-modestrip .sk-m")[2].className).toContain("on");
    fireEvent.click(container.querySelectorAll(".sk-modestrip .sk-m")[0]); // Library
    expect(screen.getByText("No skills yet")).toBeTruthy();
  });

  it("renders real invocation metrics from the usage log", async () => {
    const now = Date.now();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_skill_log") {
        return [
          `${now} · t0p1 · PreToolUse · open-a-clean-pr`,
          `${now} · t0p1 · PostToolUse · open-a-clean-pr`,
          `${now} · t0p1 · PreToolUse · open-a-clean-pr`,
        ].join("\n");
      }
      return null;
    });
    const { container } = render(<SkillsScreen />);
    // The leaderboard should surface the invoked skill once the log resolves.
    await waitFor(() => {
      expect(container.querySelector(".sk-hbar")).toBeTruthy();
    });
    // 2 invocations recorded for the PR skill → its card shows "2×".
    expect(within(body(container)).getByText("2×")).toBeTruthy();
  });
});
