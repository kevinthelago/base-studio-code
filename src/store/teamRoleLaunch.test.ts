// Team role-actor hub launch (#3103): a repo-less stream — the shape `teamRoleStreams` emits for a
// team's curator/documentor/… — must launch at the project HUB (like the director), NOT in a per-repo
// worktree, while its persona still drives the pane role. Workers are unaffected. Verified through
// fleetStartProject without a real git worktree or Tauri process (mirrors loadStream.test.ts).

import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";
import type { AgentStream, FleetPlan } from "@/features/planner/fleet/planFleet";
import type { Persona } from "@/features/personas";
import { sanitizeProjectKey } from "@/shared/lib/core/projectPaths";

const NAME = "team-launch-test";
const KEY = sanitizeProjectKey(NAME);
const HUB = "/home/user/.base-studio-code/projects/team-launch-test";

const fleet = (streams: AgentStream[]): FleetPlan => ({ recommended: 1, reasoning: "t", streams, director: { enabled: false } });

const curatorPersona: Persona = { id: "persona-curator", name: "Curator", blurb: "", role: "curator", startPrompt: "harvest the library", skills: [] };

// A repo-less role-actor stream (exactly what teamRoleStreams produces).
const curatorStream: AgentStream = { id: "curator", name: "Curator", repo: "", owns: [], issues: [], dependsOn: [], persona: "persona-curator" };
const workerStream: AgentStream = { id: "engine", name: "Engine", repo: "org/app", owns: ["src/**"], issues: ["#1"], dependsOn: [] };

describe("team role-actor hub launch (#3103)", () => {
  beforeEach(() => {
    useAppStore.setState({ tabs: [], bscBaseDir: "/home/user/.base-studio-code", fleetPaneStreams: {}, personas: [curatorPersona] });
  });

  it("routes a repo-less role-actor to the HUB cwd and its persona role; the worker keeps its worktree", () => {
    useAppStore.getState().fleetStartProject(NAME, fleet([workerStream, curatorStream]), KEY, {
      hubPath: HUB, worktreePaths: { engine: "/wt/engine" },
    });
    const s = useAppStore.getState();
    const curatorPane = `${KEY}:curator`;
    expect(s.paneRoles[curatorPane]).toBe("curator");   // persona resolves the role
    expect(s.paneCwds[curatorPane]).toBe(HUB);           // hub-scoped, NOT a worktree path
    // The worker is unaffected — worktree cwd + worker role.
    const workerPane = `${KEY}:engine`;
    expect(s.paneRoles[workerPane]).toBe("worker");
    expect(s.paneCwds[workerPane]).toBe("/wt/engine");
  });

  it("falls back to the derived hub dir when no absolute hubPath is passed (never a worktree path)", () => {
    useAppStore.getState().fleetStartProject(NAME, fleet([curatorStream]), KEY);
    const cwd = useAppStore.getState().paneCwds[`${KEY}:curator`];
    // Derived hub path (projectHubCwd) — contains the project key under the base dir, and is NOT the
    // worktrees tree (a repo-less stream must never resolve to an agentWorktreeCwd).
    expect(cwd).toContain(KEY);
    expect(cwd).not.toContain("worktrees");
  });
});
