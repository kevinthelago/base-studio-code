import { describe, it, expect } from "vitest";
import { BUILTIN_ORGS, STUDIO_NETWORK_ID } from "@/features/teams";
import { BUILTIN_PERSONAS } from "@/features/personas";
import { buildStudioFleetData, studioPaneIdForNode, studioNodeHome, studioSessionLive, applyStudioLiveStatus, BASE_STUDIO_PROJECT, BASE_STUDIO_PROJECT_ID } from "./studioProject";
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

describe("studioNodeHome (#glance-resume / #3357)", () => {
  it("sends the debugger to the in-graph morph (it's hosted on the shared TerminalHost)", () => {
    expect(studioNodeHome("debugger")).toEqual({ kind: "morph" });
  });

  it("sends EVERY studio session to the in-graph morph now that all four live on TerminalHost (#3357)", () => {
    // Before #3357 the designer/librarian/architect ran their own single-mount xterm (`useScreenSession`),
    // which the host could not re-parent — so opening one had to navigate to its workspace page. They are
    // now TerminalHost-hosted like the debugger, so the graph morphs the node into the live terminal
    // instead of throwing the user onto another page.
    for (const id of ["designer", "librarian", "architect", "debugger"]) {
      expect(studioNodeHome(id)).toEqual({ kind: "morph" });
    }
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

// #3421: studio nodes are keyed by their STABLE app-owned session id, not `fleetPaneId(project, node)`.
// Running the fleet overlay over them looked up `<project>:designer`, which never exists — so no studio
// node was ever found live. Invisible while unmatched nodes fell through to idle; #3415 made them read
// `off`, pinning every studio node `off` however its session was doing.
describe("applyStudioLiveStatus (#3421)", () => {
  const node = (id: string) => ({ id, slug: id, role: "service" as const, roleLabel: id, health: "off" as const, activity: "idle" as const });
  const sig = (over: Partial<{ debugSession: boolean; paneClaudeActive: Record<string, boolean>; paneStatus: Record<string, string | undefined> }> = {}) =>
    ({ debugSession: false, paneClaudeActive: {}, paneStatus: {}, ...over });
  const of = (nodes: ReturnType<typeof node>[], s: ReturnType<typeof sig>) =>
    Object.fromEntries(applyStudioLiveStatus(nodes, s).map((n) => [n.id, { health: n.health, activity: n.activity }]));

  it("a studio with no mounted session reads off — not idle", () => {
    expect(of([node("designer")], sig())).toEqual({ designer: { health: "off", activity: "idle" } });
  });

  it("a MOUNTED but quiet studio reads idle — the session exists, it just is not working", () => {
    const r = of([node("designer")], sig({ paneClaudeActive: { [DESIGN_STUDIO_SESSION_ID]: true } }));
    expect(r).toEqual({ designer: { health: "off", activity: "idle" } });
  });

  it("a WORKING studio reads healthy · building", () => {
    const r = of([node("designer")], sig({ paneStatus: { [DESIGN_STUDIO_SESSION_ID]: "run" } }));
    expect(r).toEqual({ designer: { health: "healthy", activity: "building" } });
  });

  // The regression itself: turning a studio ON must move it off `off`.
  it("turning a studio on moves it off `off` — the #3421 regression", () => {
    const before = of([node("designer")], sig());
    const after = of([node("designer")], sig({ paneStatus: { [DESIGN_STUDIO_SESSION_ID]: "run" } }));
    expect(before.designer.health).toBe("off");
    expect(after.designer.health).not.toBe("off");
  });

  it("keys each studio by its OWN session id — one running studio never lights up another", () => {
    const r = of([node("designer"), node("librarian"), node("architect")], sig({ paneStatus: { [ALGORITHMS_STUDIO_SESSION_ID]: "run" } }));
    expect(r.librarian.health).toBe("healthy");
    expect(r.designer.health).toBe("off");
    expect(r.architect.health).toBe("off");
  });

  it("the debugger follows the debugSession flag, not a pane status", () => {
    expect(of([node("debugger")], sig({ debugSession: true })).debugger.health).toBe("off");
    expect(of([node("debugger")], sig({ debugSession: false })).debugger.health).toBe("off");
  });

  // A library has no session — forcing it `off` would misreport it as a dead one.
  it("leaves a node with no fixed session untouched (a library, the dynamic planner)", () => {
    const lib = { ...node("algorithms"), health: "off" as const };
    expect(applyStudioLiveStatus([lib], sig())).toEqual([lib]);
  });
});

describe("overflow pool sessions appear as openable nodes (#3535)", () => {
  it("resolves a pool node to ITS pane — without this the node cannot be opened at all", () => {
    // The static studio map covers only the five fixed studios. A pool session is dynamic, so a missing
    // branch here means a live session with a node that opens nothing — or no node at all.
    expect(studioPaneIdForNode("debugger-pool-7")).toBe("debug-studio:pool-7");
    expect(studioPaneIdForNode("debugger-pool-12")).toBe("debug-studio:pool-12");
  });

  it("still resolves the fixed studios, and still refuses a non-session node", () => {
    expect(studioPaneIdForNode("designer")).toBe("design-studio:designer");
    expect(studioPaneIdForNode("debugger")).toBe("debug-studio:debugger");
    expect(studioPaneIdForNode("some-library")).toBeNull();
    expect(studioPaneIdForNode("debugger-pool-")).toBeNull();
    expect(studioPaneIdForNode("debugger-pool-x")).toBeNull();
  });

  it("opens a request session as a morph, like every other session node", () => {
    expect(studioNodeHome("debugger-pool-3")).toEqual({ kind: "morph" });
    expect(studioNodeHome("designer")).toEqual({ kind: "morph" });
    expect(studioNodeHome("not-a-session")).toBeNull();
  });
});
