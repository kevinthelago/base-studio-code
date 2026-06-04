import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../store";
import type { FleetPlan } from "../screens/projects/planSections";

// Launch-time resolution of reference context (#326): the store lifts its flat
// refContext* assignment fields into the assignments-module cascade and stamps
// each launched pane's resolved reference docs into paneReferenceDocs, which
// TerminalView then reads + injects. These tests drive the real store actions.

const fleet: FleetPlan = {
  recommended: 2,
  reasoning: "r",
  director: { enabled: true, role: "integrator" },
  streams: [
    { id: "auth-ui", name: "Auth UI", repo: "own/web", owns: ["src/auth/**"], issues: [], dependsOn: [], prompt: "prompts/auth-ui-kickoff.md" },
    { id: "api", name: "API", repo: "own/api", owns: [], issues: [], dependsOn: [] },
  ],
};

beforeEach(() => {
  useAppStore.setState({
    tabs: [],
    activeTabIdx: 0,
    bscBaseDir: "/base",
    paneReferenceDocs: {},
    refContextDefault: [],
    refContextProject: {},
    refContextRepo: {},
    defaultStartupPromptDoc: null,
    projectStartupPromptDoc: {},
    repoStartupPromptDoc: {},
    repoTriagePromptDoc: {},
  });
});

describe("fleetStartProject — reference context delivery", () => {
  it("injects the global default reference docs into every launched pane", () => {
    useAppStore.setState({ refContextDefault: ["documents/global.md"] });
    useAppStore.getState().fleetStartProject("Proj", fleet, "proj-key");
    const st = useAppStore.getState();
    const idx = st.findFleetTabIdx("proj-key");
    // director + both workers all see the global block
    expect(st.paneReferenceDocs[`t${idx}p0`]).toEqual(["documents/global.md"]);
    expect(st.paneReferenceDocs[`t${idx}p1`]).toEqual(["documents/global.md"]);
    expect(st.paneReferenceDocs[`t${idx}p2`]).toEqual(["documents/global.md"]);
  });

  it("accumulates project-level docs (keyed by the sanitized project key) onto the default", () => {
    useAppStore.setState({
      refContextDefault: ["documents/global.md"],
      refContextProject: { "proj-key": ["documents/proj.md"] },
    });
    useAppStore.getState().fleetStartProject("Proj", fleet, "proj-key");
    const st = useAppStore.getState();
    const idx = st.findFleetTabIdx("proj-key");
    expect(st.paneReferenceDocs[`t${idx}p1`]).toEqual(["documents/global.md", "documents/proj.md"]);
  });

  it("adds repo-scoped docs only to that repo's worker", () => {
    useAppStore.setState({
      refContextRepo: { "proj-key::own/web": ["documents/web.md"] },
    });
    useAppStore.getState().fleetStartProject("Proj", fleet, "proj-key");
    const st = useAppStore.getState();
    const idx = st.findFleetTabIdx("proj-key");
    expect(st.paneReferenceDocs[`t${idx}p1`]).toEqual(["documents/web.md"]); // own/web worker
    expect(st.paneReferenceDocs[`t${idx}p2`]).toBeUndefined();               // own/api worker — none
  });

  it("leaves paneReferenceDocs unset when nothing is assigned", () => {
    useAppStore.getState().fleetStartProject("Proj", fleet, "proj-key");
    const st = useAppStore.getState();
    const idx = st.findFleetTabIdx("proj-key");
    expect(st.paneReferenceDocs[`t${idx}p0`]).toBeUndefined();
    expect(st.paneReferenceDocs[`t${idx}p1`]).toBeUndefined();
  });
});

describe("triageStartProject — reference context delivery", () => {
  it("injects default + project reference docs into each triage pane", () => {
    useAppStore.setState({
      refContextDefault: ["documents/global.md"],
      refContextProject: { Proj: ["documents/proj.md"] }, // sanitized key of "Proj"
    });
    useAppStore.getState().triageStartProject("Proj", ["own/web"]);
    const st = useAppStore.getState();
    const idx = st.tabs.findIndex(t => t.name === "Proj · triage");
    expect(st.paneReferenceDocs[`t${idx}p0`]).toEqual(["documents/global.md", "documents/proj.md"]);
  });
});
