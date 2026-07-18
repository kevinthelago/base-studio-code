import { describe, it, expect } from "vitest";
import { BUILTIN_ORGS, STUDIO_NETWORK_ID } from "@/features/teams";
import { BUILTIN_PERSONAS } from "@/features/personas";
import { buildStudioFleetData, studioPaneIdForNode, studioNodeHome, studioSessionLive, BASE_STUDIO_PROJECT, BASE_STUDIO_PROJECT_ID } from "./studioProject";
import {
  DEBUG_STUDIO_SESSION_ID, DESIGN_STUDIO_SESSION_ID,
  ALGORITHMS_STUDIO_SESSION_ID, TEAMS_STUDIO_SESSION_ID,
} from "@/shared/lib/session/systemSessions";

describe("studioProject (#3319)", () => {
  it("the base-studio-code project id is namespaced so it can't collide with a real project slug", () => {
    expect(BASE_STUDIO_PROJECT.id).toBe(BASE_STUDIO_PROJECT_ID);
    expect(BASE_STUDIO_PROJECT_ID).toContain(":"); // a colon → never a projectSlug ([a-z0-9-])
    expect(BASE_STUDIO_PROJECT.name).toBe("base-studio-code");
  });

  it("renders the Studio Network team's positions as nodes and relationships as edges", () => {
    const d = buildStudioFleetData(BUILTIN_ORGS, BUILTIN_PERSONAS, false);
    expect(d).not.toBeNull();
    const ids = d!.rawNodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["designer", "librarian", "architect"]));
    expect(d!.rawEdges.length).toBeGreaterThan(0);
  });

  it("includes the debugger node IFF the debug toggle is on (#3317 augmentation)", () => {
    const off = buildStudioFleetData(BUILTIN_ORGS, BUILTIN_PERSONAS, false);
    const on = buildStudioFleetData(BUILTIN_ORGS, BUILTIN_PERSONAS, true);
    expect(off!.rawNodes.some((n) => n.id === "debugger")).toBe(false);
    expect(on!.rawNodes.some((n) => n.id === "debugger")).toBe(true);
  });

  it("returns null when the Studio Network team isn't present (caller falls back, never crashes)", () => {
    expect(buildStudioFleetData([], BUILTIN_PERSONAS, false)).toBeNull();
    const others = BUILTIN_ORGS.filter((t) => t.id !== STUDIO_NETWORK_ID);
    expect(buildStudioFleetData(others, BUILTIN_PERSONAS, false)).toBeNull();
  });

  it("marks library resource positions so the canvas draws them distinctly, not as agents (#3322)", () => {
    const d = buildStudioFleetData(BUILTIN_ORGS, BUILTIN_PERSONAS, false)!;
    expect(d.rawNodes.find((n) => n.id === "library")?.resource).toBe(true);
    expect(d.rawNodes.find((n) => n.id === "designer")?.resource).toBeFalsy(); // an agent is not a resource
  });
});

describe("studioPaneIdForNode (#3326)", () => {
  it("maps the debugger node to the TerminalHost-hosted debug session pane id", () => {
    expect(studioPaneIdForNode("debugger")).toBe(DEBUG_STUDIO_SESSION_ID);
    // The mapped id is the ACTUAL node id `buildStudioFleetData` emits when the toggle is on — so the
    // morph wiring can't drift from the graph node.
    const on = buildStudioFleetData(BUILTIN_ORGS, BUILTIN_PERSONAS, true)!;
    const debugNodeId = on.rawNodes.find((n) => n.id === "debugger")!.id;
    expect(studioPaneIdForNode(debugNodeId)).toBe(DEBUG_STUDIO_SESSION_ID);
  });

  // #glance-resume: the designer/librarian/architect now map to their OWN app-owned session ids too, so
  // the graph recognises a running studio session instead of treating the node as session-less.
  it("maps every studio agent node to its stable app-owned session id", () => {
    expect(studioPaneIdForNode("designer")).toBe(DESIGN_STUDIO_SESSION_ID);
    expect(studioPaneIdForNode("librarian")).toBe(ALGORITHMS_STUDIO_SESSION_ID);
    expect(studioPaneIdForNode("architect")).toBe(TEAMS_STUDIO_SESSION_ID);
    // The mapped ids are the ACTUAL node ids buildStudioFleetData emits, so the wiring can't drift.
    const d = buildStudioFleetData(BUILTIN_ORGS, BUILTIN_PERSONAS, false)!;
    for (const id of ["designer", "librarian", "architect"]) {
      expect(d.rawNodes.some((n) => n.id === id)).toBe(true);
      expect(studioPaneIdForNode(id)).not.toBeNull();
    }
  });

  it("returns null for resource/library nodes, the dynamic planner, and any non-studio node", () => {
    for (const id of ["library", "algorithms", "teams", "planner", "proj:auth", "director"]) {
      expect(studioPaneIdForNode(id)).toBeNull();
    }
  });
});

describe("studioNodeHome (#glance-resume)", () => {
  it("sends the debugger to the in-graph morph (it's hosted on the shared TerminalHost)", () => {
    expect(studioNodeHome("debugger")).toEqual({ kind: "morph" });
  });

  it("sends each workspace-hosted studio session to its own page", () => {
    expect(studioNodeHome("designer")).toEqual({ kind: "page", pageMode: "designs" });
    expect(studioNodeHome("librarian")).toEqual({ kind: "page", pageMode: "algorithms" });
    expect(studioNodeHome("architect")).toEqual({ kind: "page", pageMode: "teams" });
  });

  it("has no home for a resource/library node or a non-studio node (nothing to open)", () => {
    for (const id of ["library", "algorithms", "teams", "planner", "director"]) {
      expect(studioNodeHome(id)).toBeNull();
    }
  });
});

describe("studioSessionLive (#glance-resume)", () => {
  const none = { debugSession: false, paneClaudeActive: {}, paneStatus: {} };

  it("reads the debugger from the Settings debug toggle", () => {
    expect(studioSessionLive("debugger", { ...none, debugSession: true })).toBe(true);
    expect(studioSessionLive("debugger", none)).toBe(false);
  });

  it("recognises a RUNNING designer session (the node reflects the live session, not a planned position)", () => {
    expect(studioSessionLive("designer", { ...none, paneClaudeActive: { [DESIGN_STUDIO_SESSION_ID]: true } })).toBe(true);
    expect(studioSessionLive("designer", { ...none, paneStatus: { [DESIGN_STUDIO_SESSION_ID]: "run" } })).toBe(true);
    expect(studioSessionLive("designer", { ...none, paneStatus: { [DESIGN_STUDIO_SESSION_ID]: "on" } })).toBe(true);
  });

  it("is false when the session isn't up, and for a node with no session at all", () => {
    expect(studioSessionLive("designer", none)).toBe(false);
    expect(studioSessionLive("designer", { ...none, paneStatus: { [DESIGN_STUDIO_SESSION_ID]: "idle" } })).toBe(false);
    expect(studioSessionLive("library", { ...none, debugSession: true })).toBe(false);
  });
});
