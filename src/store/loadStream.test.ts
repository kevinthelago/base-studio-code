// ls-stream: unit tests for the load migration stream wiring in fleetStartProject (#ls-stream).
//
// Verifies that when a fleet plan contains the "load-stream" AgentStream with the correct
// owns/dependsOn, fleetStartProject wires paneRoleGlobs, fleetPaneStreams, and the startup
// prompt doc correctly — without requiring a real git worktree or Tauri process.

import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";
import { resetFleetPanes } from "@/test/storeReset";
import type { AgentStream, FleetPlan } from "@/features/planner/fleet/planFleet";
import { sanitizeProjectKey } from "@/shared/lib/core/projectPaths";

const LOAD_STREAM_OWNS = [
  "src/store/index.ts",
  "src-tauri/src/lib.rs",
  "@/features/planner/LoadReconcile.tsx",
  "crates/data/src/reconcile.rs",
  "crates/data/src/ddl.rs",
  "prompts/load-stream-kickoff.md",
  "src/__tests__/loadStream.test.ts",
  "src/__tests__/loadReconcile.test.tsx",
];

function loadStream(p: Partial<AgentStream> = {}): AgentStream {
  return {
    id: "load-stream",
    name: "Build-time load",
    repo: "org/studio-code",
    owns: LOAD_STREAM_OWNS,
    issues: ["ls-stream", "ls-reconcile-ui", "ls-lineage-verify"],
    dependsOn: ["source-experience"],
    prompt: "prompts/load-stream-kickoff.md",
    ...p,
  };
}

function fleet(streams: AgentStream[]): FleetPlan {
  return {
    recommended: 2,
    reasoning: "test",
    streams,
    director: { enabled: false },
  };
}

const PROJECT_NAME = "migration-test";
const PROJECT_KEY  = sanitizeProjectKey(PROJECT_NAME);

describe("load-stream fleet wiring (#ls-stream)", () => {
  beforeEach(() => {
    // #3836: `paneRoleGlobs` is what this suite ASSERTS on and a sibling launch populates it, so it
    // has to be cleared here or a later test reads the earlier project's globs.
    resetFleetPanes();
    useAppStore.setState({ tabs: [], bscBaseDir: "/home/user/.base-studio-code" });
  });

  it("paneRoleGlobs contains all load-stream owns, expanding trailing-slash globs", () => {
    const rows = useAppStore.getState().fleetStartProject(PROJECT_NAME, fleet([loadStream()]), PROJECT_KEY);
    const { paneRoleGlobs } = useAppStore.getState();

    // Find the pane the LOAD STREAM landed in — by its stream id, not by "the first pane with any
    // globs". The commons lane carries globs now (#funnel-commons-and-integration-streams) and it
    // launches FIRST, so a positional lookup silently reads the commons set instead.
    const { fleetPaneStreams } = useAppStore.getState();
    const paneId = Object.keys(fleetPaneStreams).find((k) => fleetPaneStreams[k].id === "load-stream");
    expect(paneId).toBeDefined();
    const globs = paneRoleGlobs[paneId!];

    // Every owned path from LOAD_STREAM_OWNS should appear in the role globs
    for (const owned of LOAD_STREAM_OWNS) {
      const expected = owned.endsWith("/") ? owned + "**" : owned;
      expect(globs).toContain(expected);
    }

    // One roster row per session: the load stream plus the two lanes every project now gets.
    expect(rows.length).toBe(3);
  });

  it("fleetPaneStreams records the load-stream AgentStream", () => {
    useAppStore.getState().fleetStartProject(PROJECT_NAME, fleet([loadStream()]), PROJECT_KEY);
    const { fleetPaneStreams } = useAppStore.getState();
    const streams = Object.values(fleetPaneStreams);
    // The load stream plus the commons + integration lanes.
    expect(streams.length).toBe(3);
    const s = streams.find((x) => x.id === "load-stream")!;
    expect(s).toBeDefined();
    expect(s.dependsOn).toContain("source-experience");
    expect(s.issues).toEqual(expect.arrayContaining(["ls-stream", "ls-reconcile-ui", "ls-lineage-verify"]));
  });

  it("paneStartupPromptDocs points to the kickoff relpath when stream.prompt is set", () => {
    useAppStore.getState().fleetStartProject(PROJECT_NAME, fleet([loadStream()]), PROJECT_KEY);
    const { paneStartupPromptDocs } = useAppStore.getState();
    const docs = Object.values(paneStartupPromptDocs);
    // The doc relpath is built as scriptDocRelpath(safeKey, sess.prompt)
    expect(docs.some((d) => d.includes("load-stream-kickoff.md"))).toBe(true);
  });

  it("a stream without a prompt falls back to paneStartupPromptText", () => {
    const streamNoPrompt = loadStream({ prompt: undefined });
    useAppStore.getState().fleetStartProject(PROJECT_NAME, fleet([streamNoPrompt]), PROJECT_KEY);
    const { paneStartupPromptText } = useAppStore.getState();
    const texts = Object.values(paneStartupPromptText);
    // fallback text should mention the stream name / id
    expect(texts.some((t) => t.includes("load-stream") || t.includes("Build-time load"))).toBe(true);
  });

  it("a fleet with two streams produces a pane wiring entry per stream, plus the two lanes", () => {
    const second: AgentStream = {
      id: "source-experience", name: "Source XP", repo: "org/studio-code",
      owns: ["src-tauri/src/data.rs"], issues: ["se-1"], dependsOn: [],
    };
    useAppStore.getState().fleetStartProject(PROJECT_NAME, fleet([loadStream(), second]), PROJECT_KEY);
    const streams = Object.values(useAppStore.getState().fleetPaneStreams);
    // Two feature streams + the commons and integration lanes. Both streams share a repo here, so it
    // is ONE pair of lanes, not one pair per stream.
    expect(streams).toHaveLength(4);
    expect(streams.map((s) => s.id)).toEqual(
      expect.arrayContaining(["load-stream", "source-experience", "commons", "integration"]),
    );
  });

  it("gives a DIRECTOR-LESS fleet the commons lane — the owner is a worker, not the director", () => {
    // This whole suite runs `director: { enabled: false }`. Before the funnel that meant NO commons
    // set was derived at all (the DIRECTOR was the steward, so a director-less fleet had none) and
    // every feature stream was left free to write `.gitignore`. That gap is what these lanes close.
    useAppStore.getState().fleetStartProject(PROJECT_NAME, fleet([loadStream()]), PROJECT_KEY);
    const { fleetPaneStreams, paneRoleGlobs } = useAppStore.getState();
    const commonsPane = Object.keys(fleetPaneStreams).find((k) => fleetPaneStreams[k].id === "commons");
    expect(commonsPane).toBeDefined();
    expect(paneRoleGlobs[commonsPane!]).toContain(".gitignore");
    // …and the feature stream gates on it rather than racing it.
    const load = Object.values(fleetPaneStreams).find((s) => s.id === "load-stream")!;
    expect(load.dependsOn).toContain("commons");
  });
});
