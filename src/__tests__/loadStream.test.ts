// ls-stream: unit tests for the load migration stream wiring in fleetStartProject (#ls-stream).
//
// Verifies that when a fleet plan contains the "load-stream" AgentStream with the correct
// owns/dependsOn, fleetStartProject wires paneRoleGlobs, fleetPaneStreams, and the startup
// prompt doc correctly — without requiring a real git worktree or Tauri process.

import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../store";
import type { AgentStream, FleetPlan } from "../screens/planner/stages/planSections";
import { sanitizeProjectKey } from "../lib/projectPaths";

const LOAD_STREAM_OWNS = [
  "src/store/index.ts",
  "src-tauri/src/lib.rs",
  "src/screens/planner/LoadReconcile.tsx",
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
    useAppStore.setState({ tabs: [], bscBaseDir: "/home/user/.base-studio-code", fleetPaneStreams: {} });
  });

  it("paneRoleGlobs contains all load-stream owns, expanding trailing-slash globs", () => {
    const rows = useAppStore.getState().fleetStartProject(PROJECT_NAME, fleet([loadStream()]), PROJECT_KEY);
    const { paneRoleGlobs } = useAppStore.getState();

    // Find the pane that the load stream landed in
    const paneId = Object.keys(paneRoleGlobs).find((k) => paneRoleGlobs[k].length > 0);
    expect(paneId).toBeDefined();
    const globs = paneRoleGlobs[paneId!];

    // Every owned path from LOAD_STREAM_OWNS should appear in the role globs
    for (const owned of LOAD_STREAM_OWNS) {
      const expected = owned.endsWith("/") ? owned + "**" : owned;
      expect(globs).toContain(expected);
    }

    // roster rows returned
    expect(rows.length).toBe(1);
  });

  it("fleetPaneStreams records the load-stream AgentStream", () => {
    useAppStore.getState().fleetStartProject(PROJECT_NAME, fleet([loadStream()]), PROJECT_KEY);
    const { fleetPaneStreams } = useAppStore.getState();
    const streams = Object.values(fleetPaneStreams);
    expect(streams.length).toBe(1);
    const s = streams[0];
    expect(s.id).toBe("load-stream");
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

  it("a fleet with two streams produces two pane wiring entries", () => {
    const second: AgentStream = {
      id: "source-experience", name: "Source XP", repo: "org/studio-code",
      owns: ["src-tauri/src/data.rs"], issues: ["se-1"], dependsOn: [],
    };
    useAppStore.getState().fleetStartProject(PROJECT_NAME, fleet([loadStream(), second]), PROJECT_KEY);
    const streams = Object.values(useAppStore.getState().fleetPaneStreams);
    expect(streams).toHaveLength(2);
    expect(streams.map((s) => s.id)).toEqual(expect.arrayContaining(["load-stream", "source-experience"]));
  });
});
