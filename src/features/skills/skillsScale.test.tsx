import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SkillsScreen } from "./";
import { useAppStore } from "@/store";
import { blankSkill, skillSlug } from "./lib/skills";

const ROW = ".skill-row";

const LIB = [
  { ...blankSkill(), id: "w1", name: "Open a clean PR", kind: "workflow" as const, enabled: true },
  { ...blankSkill(), id: "w2", name: "Cut a release", kind: "workflow" as const, enabled: true },
  { ...blankSkill(), id: "sc1", name: "Scaffold a command", kind: "scaffold" as const, enabled: true },
  { ...blankSkill(), id: "r1", name: "Security review", kind: "review" as const, enabled: true },
];

/** Build a TSV `bsc-skill` log: `n` PreToolUse (invocations) + `ok` PostToolUse (successes) today. */
function logFor(entries: Array<{ name: string; n: number; ok: number }>): string[] {
  const ts = new Date().toISOString();
  const lines: string[] = [];
  for (const e of entries) {
    const slug = skillSlug(e.name);
    for (let i = 0; i < e.n; i++) lines.push(`${ts}\tpane1\tPreToolUse\t${slug}`);
    for (let i = 0; i < e.ok; i++) lines.push(`${ts}\tpane1\tPostToolUse\t${slug}`);
  }
  return lines;
}

describe("SkillsScreen — KPI leaderboard digest", () => {
  beforeEach(() => {
    useAppStore.setState({ skills: LIB, skillGroups: [], sessionSkillGroups: {}, paneSkills: {}, githubToken: "" });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("the digest is collapsed by default — no leaderboard until expanded", () => {
    const { container } = render(<SkillsScreen />);
    expect(container.querySelector(".skills-leaderboard")).toBeNull();
    expect(container.querySelector(".skills-digest")).toBeNull();
  });

  it("expanding the digest renders the tiles + 'Most invoked' leaderboard ranked by invocations", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "read_skill_log"
        ? logFor([{ name: "Cut a release", n: 12, ok: 12 }, { name: "Open a clean PR", n: 5, ok: 4 }])
        : null,
    );
    const { container } = render(<SkillsScreen />);
    // telemetry merges asynchronously; wait for the usage to land.
    await waitFor(() => expect(screen.getByText("12×")).toBeTruthy());

    fireEvent.click(screen.getByText("Fleet digest · 7d"));
    const board = container.querySelector(".skills-leaderboard") as HTMLElement;
    expect(board).toBeTruthy();
    expect(within(board).getByText("Most invoked")).toBeTruthy();
    // most-invoked first (rank 1), with its success %.
    expect(within(board).getByText(/1\s+Cut a release/)).toBeTruthy();
    expect(within(board).getByText(/2\s+Open a clean PR/)).toBeTruthy();
    expect(within(board).getByText("12×")).toBeTruthy();
    // digest tiles present
    expect(container.querySelector(".skills-digest")).toBeTruthy();
    expect(screen.getByText("Never run")).toBeTruthy();
  });

  it("with no invocations the expanded leaderboard shows an empty hint", () => {
    render(<SkillsScreen />);
    fireEvent.click(screen.getByText("Fleet digest · 7d"));
    expect(screen.getByText(/No invocations yet/)).toBeTruthy();
  });
});

describe("SkillsScreen — bulk Set scope + Export", () => {
  beforeEach(() => {
    useAppStore.setState({ skills: LIB, skillGroups: [], sessionSkillGroups: {}, paneSkills: {}, githubToken: "" });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  const enterSelectAndPick = (container: HTMLElement, ids: string[]) => {
    fireEvent.click(screen.getByText("☑ Select"));
    for (const id of ids) fireEvent.click(container.querySelector(`${ROW}[data-skill-id="${id}"]`) as HTMLElement);
  };

  it("the bulk bar exposes Set scope… and Export (matching the design)", () => {
    const { container } = render(<SkillsScreen />);
    enterSelectAndPick(container, ["w1"]);
    expect(screen.getByText("Set scope…")).toBeTruthy();
    expect(screen.getByText("Export")).toBeTruthy();
  });

  it("Set scope… → Global clears the selected skills' project scope", () => {
    useAppStore.setState({
      skills: LIB.map((s) => (s.id === "w1" || s.id === "w2" ? { ...s, projects: ["42"] } : s)),
    });
    const { container } = render(<SkillsScreen />);
    enterSelectAndPick(container, ["w1", "w2"]);
    fireEvent.click(screen.getByText("Set scope…"));
    fireEvent.click(screen.getByText("Global (all projects)"));
    const st = useAppStore.getState().skills;
    expect(st.find((s) => s.id === "w1")!.projects).toEqual([]);
    expect(st.find((s) => s.id === "w2")!.projects).toEqual([]);
    // untouched skill keeps its (empty) scope
    expect(st.find((s) => s.id === "sc1")!.projects).toEqual([]);
  });

  it("Export builds a JSON blob of exactly the selected skills and triggers a download", () => {
    const createURL = vi.fn((_blob: Blob) => "blob:mock");
    const revokeURL = vi.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeURL;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const { container } = render(<SkillsScreen />);
    enterSelectAndPick(container, ["w1", "r1"]);
    fireEvent.click(screen.getByText("Export"));

    expect(createURL).toHaveBeenCalledTimes(1);
    const blob = createURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("application/json");
    expect(click).toHaveBeenCalled();
    expect(revokeURL).toHaveBeenCalled();
    click.mockRestore();
  });

  it("Export of the blob contains only the selected skills' definitions", async () => {
    const createURL = vi.fn((_blob: Blob) => "blob:mock");
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const { container } = render(<SkillsScreen />);
    enterSelectAndPick(container, ["w1", "r1"]);
    fireEvent.click(screen.getByText("Export"));

    const blob = createURL.mock.calls[0][0] as Blob;
    const parsed = JSON.parse(await blob.text()) as Array<{ id: string }>;
    expect(parsed.map((s) => s.id).sort()).toEqual(["r1", "w1"]);
  });
});
