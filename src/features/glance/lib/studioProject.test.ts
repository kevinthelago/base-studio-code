import { describe, it, expect } from "vitest";
import { BUILTIN_ORGS, STUDIO_NETWORK_ID } from "@/features/teams";
import { BUILTIN_PERSONAS } from "@/features/personas";
import { buildStudioFleetData, studioPaneIdForNode, BASE_STUDIO_PROJECT, BASE_STUDIO_PROJECT_ID } from "./studioProject";
import { DEBUG_STUDIO_SESSION_ID } from "@/shared/lib/session/systemSessions";

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

  it("returns null for the not-yet-migrated studios and any non-studio node (a click just selects them)", () => {
    for (const id of ["designer", "librarian", "architect", "library", "proj:auth", "director"]) {
      expect(studioPaneIdForNode(id)).toBeNull();
    }
  });
});
