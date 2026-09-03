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

  // ── the model a role-actor launches on (a-model-cannot-be-chosen-from-the-command-surface) ────
  //
  // End to end, because the value crosses three hands — the team record, `teamRoleStreams`, and this
  // launch — and the middle one is the only place a unit test would otherwise see it.

  it("launches a role-actor on its placement's model, then the persona's, then the harness default", () => {
    // A persona carrying its own default, placed once. The stream shape is what `teamRoleStreams`
    // emits: the placement's override (when there is one) lands on `model`.
    useAppStore.setState({
      tabs: [], bscBaseDir: "/home/user/.base-studio-code", fleetPaneStreams: {}, paneModels: {},
      personas: [{ ...curatorPersona, model: "opus-4.5" }],
    });
    useAppStore.getState().fleetStartProject(NAME, fleet([{ ...curatorStream, model: "haiku-4.5" }]), KEY, { hubPath: HUB });
    // The placement wins over the persona's default — the point of the override.
    expect(useAppStore.getState().paneModels[`${KEY}:curator`]).toBe("haiku-4.5");

    // No override → the persona's own default.
    useAppStore.setState({ tabs: [], fleetPaneStreams: {}, paneModels: {} });
    useAppStore.getState().fleetStartProject(NAME, fleet([curatorStream]), KEY, { hubPath: HUB });
    expect(useAppStore.getState().paneModels[`${KEY}:curator`]).toBe("opus-4.5");

    // Neither → NO pane model at all, which is what makes the session launch with no `--model` and run
    // on Claude Code's own default. An entry here would be the app choosing a tier on the user's behalf.
    useAppStore.setState({ tabs: [], fleetPaneStreams: {}, paneModels: {}, personas: [curatorPersona] });
    useAppStore.getState().fleetStartProject(NAME, fleet([curatorStream]), KEY, { hubPath: HUB });
    expect(useAppStore.getState().paneModels[`${KEY}:curator`]).toBeUndefined();
  });

  it("launches a role-actor on a LOCAL model, and routes it to bsc-agent rather than Claude", () => {
    // `a-node-cannot-carry-a-local-model`, at the far end. The unit half is
    // `src/features/planner/fleet/teamFleet.test.ts` (the position → stream hop, where the value used
    // to be dropped); this is the half that proves a carried local model actually changes which
    // HARNESS the session runs on. Asserting only `paneModels` would pass with the session still
    // launching Claude Code — the exact silent-no-op shape the item was filed about.
    useAppStore.setState({
      tabs: [], bscBaseDir: "/home/user/.base-studio-code", fleetPaneStreams: {}, paneModels: {},
      paneProviders: {}, personas: [curatorPersona],
    });
    useAppStore.getState().fleetStartProject(NAME, fleet([{ ...curatorStream, model: "qwen3.5:35b-a3b" }]), KEY, { hubPath: HUB });
    const pane = `${KEY}:curator`;
    expect(useAppStore.getState().paneModels[pane]).toBe("qwen3.5:35b-a3b");
    expect(useAppStore.getState().paneProviders[pane]).toBe("bsc-agent");
  });

  it("keeps a Claude TIER on the claude harness — the local routing is derived, not global", () => {
    // The counterpart that stops the fix from over-reaching: `providerForModel` derives `bsc-agent`
    // from a model being OUTSIDE the tier registry, so a tier must go on producing no such provider.
    useAppStore.setState({
      tabs: [], bscBaseDir: "/home/user/.base-studio-code", fleetPaneStreams: {}, paneModels: {},
      paneProviders: {}, personas: [curatorPersona],
    });
    useAppStore.getState().fleetStartProject(NAME, fleet([{ ...curatorStream, model: "haiku-4.5" }]), KEY, { hubPath: HUB });
    expect(useAppStore.getState().paneProviders[`${KEY}:curator`]).not.toBe("bsc-agent");
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
