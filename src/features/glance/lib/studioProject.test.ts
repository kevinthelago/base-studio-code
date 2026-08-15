import { describe, it, expect } from "vitest";
import { BUILTIN_ORGS, STUDIO_NETWORK_ID } from "@/features/teams";
import { BUILTIN_PERSONAS } from "@/features/personas";
import { buildStudioFleetData, buildArchitectFleetData, studioPaneIdForNode, studioNodeHome, studioSessionLive, applyStudioLiveStatus, BASE_STUDIO_PROJECT, BASE_STUDIO_PROJECT_ID } from "@/features/glance/lib/studioProject";
import {
  DEBUG_STUDIO_SESSION_ID, designerSessionId,
  librarianSessionId, TEAMS_STUDIO_SESSION_ID,
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
    expect(d.rawNodes.find((n) => n.id === "designer-react")?.resource).toBeFalsy(); // an agent is not a resource
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
    expect(studioPaneIdForNode("designer-react")).toBe(designerSessionId("react"));
    expect(studioPaneIdForNode("librarian-rust")).toBe(librarianSessionId("rust"));
    expect(studioPaneIdForNode("architect")).toBe(TEAMS_STUDIO_SESSION_ID);
    // The anti-drift check, over BOTH drills (#system-sessions-are-per-technology): every node either
    // graph emits must resolve to a pane. The two emit DIFFERENT ids — base-studio-code renders the
    // packaged ROLE team (`designer`), the architect renders per-tech SESSIONS (`designer-react`) —
    // and a node that draws but cannot open is the failure mode this pins.
    for (const d of [
      buildStudioFleetData(BUILTIN_ORGS, BUILTIN_PERSONAS, false)!,
      buildArchitectFleetData(BUILTIN_ORGS, BUILTIN_PERSONAS)!,
    ]) {
      // RESOURCE positions (the libraries each studio stewards) are not sessions and correctly resolve
      // to null — the check is about AGENT nodes.
      const resources = new Set(
        BUILTIN_ORGS.find((t) => t.id === STUDIO_NETWORK_ID)!
          .positions.filter((p) => p.kind === "resource").map((p) => p.nodeId),
      );
      for (const n of d.rawNodes.filter((x) => !resources.has(x.id) && x.id !== "planner")) {
        expect(studioPaneIdForNode(n.id), `${n.id} resolves to a pane`).not.toBeNull();
      }
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
    for (const id of ["designer-react", "librarian-rust", "architect", "debugger"]) {
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
    expect(studioSessionLive("designer-react", { ...none, paneClaudeActive: { [designerSessionId("react")]: true } })).toBe(true);
    expect(studioSessionLive("designer-react", { ...none, paneStatus: { [designerSessionId("react")]: "run" } })).toBe(true);
    expect(studioSessionLive("designer-react", { ...none, paneStatus: { [designerSessionId("react")]: "on" } })).toBe(true);
  });

  it("is false when the session isn't up, and for a node with no session at all", () => {
    expect(studioSessionLive("designer-react", none)).toBe(false);
    expect(studioSessionLive("designer-react", { ...none, paneStatus: { [designerSessionId("react")]: "idle" } })).toBe(false);
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
    expect(of([node("designer-react")], sig())).toEqual({ "designer-react": { health: "off", activity: "idle" } });
  });

  it("a MOUNTED but quiet studio reads idle — the session exists, it just is not working", () => {
    const r = of([node("designer-react")], sig({ paneClaudeActive: { [designerSessionId("react")]: true } }));
    expect(r).toEqual({ "designer-react": { health: "off", activity: "idle" } });
  });

  it("a WORKING studio reads healthy · building", () => {
    const r = of([node("designer-react")], sig({ paneStatus: { [designerSessionId("react")]: "run" } }));
    expect(r).toEqual({ "designer-react": { health: "healthy", activity: "building" } });
  });

  // The regression itself: turning a studio ON must move it off `off`.
  it("turning a studio on moves it off `off` — the #3421 regression", () => {
    const before = of([node("designer-react")], sig());
    const after = of([node("designer-react")], sig({ paneStatus: { [designerSessionId("react")]: "run" } }));
    expect(before["designer-react"].health).toBe("off");
    expect(after["designer-react"].health).not.toBe("off");
  });

  it("keys each studio by its OWN session id — one running studio never lights up another", () => {
    const r = of([node("designer-react"), node("librarian-rust"), node("architect")], sig({ paneStatus: { [librarianSessionId("rust")]: "run" } }));
    expect(r["librarian-rust"].health).toBe("healthy");
    expect(r["designer-react"].health).toBe("off");
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

describe("request sessions appear as openable nodes (#one-request-one-debug-session)", () => {
  it("resolves a request node to ITS pane — without this the node cannot be opened at all", () => {
    // The static studio map covers only the five fixed studios. A request session is dynamic, so a missing
    // branch here means a live session with a node that opens nothing — or no node at all.
    expect(studioPaneIdForNode("debugger-req-7")).toBe("debug-studio:req-7");
    expect(studioPaneIdForNode("debugger-req-12")).toBe("debug-studio:req-12");
  });

  it("still resolves the fixed studios, and still refuses a non-session node", () => {
    expect(studioPaneIdForNode("designer-react")).toBe(designerSessionId("react"));
    // The packaged team's ROLE nodes still resolve, to their default technology — the base-studio-code
    // drill renders roles, and a node that draws but cannot open is worse than no node.
    expect(studioPaneIdForNode("designer")).toBe(designerSessionId("react"));
    expect(studioPaneIdForNode("librarian")).toBe(librarianSessionId("typescript"));
    expect(studioPaneIdForNode("debugger")).toBe("debug-studio:debugger");
    expect(studioPaneIdForNode("some-library")).toBeNull();
    expect(studioPaneIdForNode("debugger-req-")).toBeNull();
    expect(studioPaneIdForNode("debugger-req-x")).toBeNull();
  });

  it("opens a request session as a morph, like every other session node", () => {
    expect(studioNodeHome("debugger-req-3")).toEqual({ kind: "morph" });
    expect(studioNodeHome("designer-react")).toEqual({ kind: "morph" });
    expect(studioNodeHome("not-a-session")).toBeNull();
  });
});
