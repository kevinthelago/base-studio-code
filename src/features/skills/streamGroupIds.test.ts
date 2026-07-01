// #1338 ph2 — a planner-assigned skill task group (AgentStream.groupIds) is expanded into a worker's
// skills at fleet launch, on top of the project-resolved set.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import type { AgentStream, FleetPlan } from "@/features/planner/fleet/planFleet";
import { blankSkill, type SkillDef } from "./lib/skills";
import { sanitizeProjectKey } from "@/shared/lib/core/projectPaths";

const PROJECT = "groupids-test";
const KEY = sanitizeProjectKey(PROJECT);

function stream(over: Partial<AgentStream> = {}): AgentStream {
  return {
    id: "render", name: "Renderer", repo: "org/app",
    owns: ["src/render/**"], issues: ["r1"], dependsOn: [],
    prompt: "prompts/render-kickoff.md", ...over,
  };
}
const fleet = (streams: AgentStream[]): FleetPlan =>
  ({ recommended: 1, reasoning: "t", streams, director: { enabled: false } });

describe("AgentStream.groupIds → worker skills (#1338)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    // A skill enabled but scoped to ANOTHER project — so it does NOT resolve for this project on its
    // own; only the group can pull it onto the worker.
    const gskill: SkillDef = { ...blankSkill(), id: "gskill", name: "Ray tracing", enabled: true, projects: ["some-other-project"] };
    useAppStore.setState({
      tabs: [], bscBaseDir: "/home/user/.base-studio-code", fleetPaneStreams: {},
      skills: [gskill],
      skillGroups: [{ id: "grp-render", name: "3D Rendering", hue: "var(--accent)", skillIds: ["gskill"] }],
      sessionSkillGroups: {}, sessionSkillOverrides: {}, paneSkills: {},
    });
  });

  it("a stream's groupIds expand the group's skills into that worker's paneSkills", () => {
    useAppStore.getState().fleetStartProject(PROJECT, fleet([stream({ groupIds: ["grp-render"] })]), KEY);
    const all = Object.values(useAppStore.getState().paneSkills).flat();
    expect(all.some((s) => s.id === "gskill")).toBe(true);
  });

  it("without groupIds the out-of-scope skill is NOT delivered (proves the group is the cause)", () => {
    useAppStore.getState().fleetStartProject(PROJECT, fleet([stream()]), KEY);
    const all = Object.values(useAppStore.getState().paneSkills).flat();
    expect(all.some((s) => s.id === "gskill")).toBe(false);
  });
});
