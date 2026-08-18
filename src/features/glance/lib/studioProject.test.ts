import { describe, it, expect } from "vitest";
import { BUILTIN_ORGS, STUDIO_NETWORK_ID } from "@/features/teams";
import { BUILTIN_PERSONAS } from "@/features/personas";
import { buildStudioFleetData, buildArchitectFleetData, studioPaneIdForNode, studioNodeHome, studioSessionLive, applyStudioLiveStatus, withProjectRequestNodes, withStudioSessions, studioNodeForOrigin, isAppProject, APP_PROJECT_KEY } from "@/features/glance/lib/studioProject";
import type { GlanceData } from "@/features/glance/lib/glanceData";
import {
  designerSessionId,
  librarianSessionId, TEAMS_STUDIO_SESSION_ID,
} from "@/shared/lib/session/systemSessions";

describe("studioProject (#3319)", () => {
  // #the-app-drills-into-a-project-that-was-deleted: the synthetic `app:base-studio-code` project is gone.
  // Its id was deliberately colon-namespaced so it could never BE a real project — which is exactly what
  // made it a second node for an app that now has a real one.
  it("the app's own project key is a REAL plan key, not a namespaced fiction", () => {
    // A plan key is `projectSlug(name)` — lowercase [a-z0-9-]. Anything else cannot name a hub on disk,
    // and naming a hub that does not exist is the whole defect this replaced.
    expect(APP_PROJECT_KEY).toMatch(/^[a-z0-9-]+$/);
    expect(isAppProject(APP_PROJECT_KEY)).toBe(true);
  });

  it("no other project is treated as the app's own", () => {
    expect(isAppProject("some-other-project")).toBe(false);
    expect(isAppProject(null)).toBe(false);
    expect(isAppProject("")).toBe(false);
    // The retired synthetic id must never match again — a leftover drill state carrying it should read
    // as "not the app's project" rather than quietly re-enabling the fold under the old key.
    expect(isAppProject("app:base-studio-code")).toBe(false);
  });

  it("renders the Studio Network team's positions as nodes and relationships as edges", () => {
    const d = buildStudioFleetData(BUILTIN_ORGS, BUILTIN_PERSONAS, []);
    expect(d).not.toBeNull();
    const ids = d!.rawNodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["designer", "librarian", "architect"]));
    expect(d!.rawEdges.length).toBeGreaterThan(0);
  });

  // #debug-nodes-hang-off-the-session-that-filed-them: no standing `debugger` node, and no toggle that
  // could add one. Debug work appears as the REQUESTS being worked, named for what each one is.
  it("draws no debugger node without requests, and one per request with them", () => {
    const none = buildStudioFleetData(BUILTIN_ORGS, BUILTIN_PERSONAS, []);
    expect(none!.rawNodes.some((n) => n.id === "debugger")).toBe(false);
    const live = buildStudioFleetData(BUILTIN_ORGS, BUILTIN_PERSONAS, [
      { id: 85, origin: designerSessionId("react"), title: "ui list needs --kit" },
    ]);
    expect(live!.rawNodes.some((n) => n.id === "debugger")).toBe(false);
    // …and the request node carries its label through to the graph, where the canvas reads `slug`.
    expect(live!.rawNodes.find((n) => n.id === "debugger-req-85")?.slug).toBe("debug - ui list needs --kit");
  });

  it("returns null when the Studio Network team isn't present (caller falls back, never crashes)", () => {
    expect(buildStudioFleetData([], BUILTIN_PERSONAS, [])).toBeNull();
    const others = BUILTIN_ORGS.filter((t) => t.id !== STUDIO_NETWORK_ID);
    expect(buildStudioFleetData(others, BUILTIN_PERSONAS, [])).toBeNull();
  });

  it("marks library resource positions so the canvas draws them distinctly, not as agents (#3322)", () => {
    const d = buildStudioFleetData(BUILTIN_ORGS, BUILTIN_PERSONAS, [])!;
    expect(d.rawNodes.find((n) => n.id === "library")?.resource).toBe(true);
    expect(d.rawNodes.find((n) => n.id === "designer-react")?.resource).toBeFalsy(); // an agent is not a resource
  });
});

describe("studioPaneIdForNode (#3326)", () => {
  it("maps a REQUEST node to its own session pane, and knows no standing debugger", () => {
    // The standing session is gone (#debug-nodes-hang-off-the-session-that-filed-them), so the bare
    // `debugger` node id resolves to nothing — while each request node still opens its own session.
    expect(studioPaneIdForNode("debugger")).toBeNull();
    const live = buildStudioFleetData(BUILTIN_ORGS, BUILTIN_PERSONAS, [
      { id: 85, origin: designerSessionId("react"), title: "x" },
    ])!;
    const nodeId = live.rawNodes.find((n) => n.id === "debugger-req-85")!.id;
    expect(studioPaneIdForNode(nodeId)).toBe("debug-studio:req-85");
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
      buildStudioFleetData(BUILTIN_ORGS, BUILTIN_PERSONAS, [])!,
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

describe("studioNodeForOrigin — pane id → the node a request hangs off", () => {
  // ASSERTED AGAINST THE REAL ID BUILDERS, never against quoted literals. The first version of this
  // resolver parsed `<role>-studio:<tech>` and returned null for every studio origin — no request node
  // would have been drawn at all — and it passed tsc, eslint, 6823 vitest and clippy, because the tests
  // quoted the same invented shape the code assumed. Importing `designerSessionId` is what makes that
  // impossible: if the id format moves, this fails.
  const perTech = new Set(["designer-react", "librarian-typescript", "architect"]);
  const roles = new Set(["designer", "librarian", "architect"]);

  it("resolves each real studio session to its per-technology node", () => {
    expect(studioNodeForOrigin(designerSessionId("react"), perTech)).toBe("designer-react");
    expect(studioNodeForOrigin(librarianSessionId("typescript"), perTech)).toBe("librarian-typescript");
    expect(studioNodeForOrigin(TEAMS_STUDIO_SESSION_ID, perTech)).toBe("architect");
  });

  it("falls back to the ROLE node, because the two drills draw different id sets", () => {
    // base-studio-code renders the packaged ROLE team (`designer`); the architect drill renders per-tech
    // sessions (`designer-react`). The same request must land in either, not only one.
    expect(studioNodeForOrigin(designerSessionId("react"), roles)).toBe("designer");
    expect(studioNodeForOrigin(librarianSessionId("rust"), roles)).toBe("librarian");
  });

  it("is null for a non-studio pane, an unknown session, and empty input", () => {
    // A director's request belongs in its project drill; attaching it to a default would assert a
    // relationship that does not exist.
    expect(studioNodeForOrigin("myproject:director", perTech)).toBeNull();
    expect(studioNodeForOrigin("design-studio:designer-elm", perTech)).toBeNull();
    expect(studioNodeForOrigin("", perTech)).toBeNull();
    expect(studioNodeForOrigin(null, perTech)).toBeNull();
  });

  it("resolves for a node set that has neither form", () => {
    expect(studioNodeForOrigin(designerSessionId("react"), new Set(["planner"]))).toBeNull();
  });
});

describe("withProjectRequestNodes — a DIRECTOR-filed request (#debug-nodes-hang-off-the-session-that-filed-them)", () => {
  // The director is the one non-studio session allowed to file a global request (workers are denied
  // that queue on purpose). Its origin resolves to no Studio Network position, so the studio graph
  // correctly skips it — and it has to land somewhere, or an app-started session is invisible.
  const drill = (): GlanceData => ({
    rawNodes: [
      { id: "director", slug: "director", role: "infra", roleLabel: "director", health: "healthy", activity: "building" },
      { id: "api", slug: "api", role: "service", roleLabel: "worker", health: "healthy", activity: "building" },
    ],
    rawEdges: [],
    sample: false,
  });

  it("adds the node against THIS project's director, labelled with the request", () => {
    const d = withProjectRequestNodes(drill(), "myproject", [
      { id: 7, origin: "myproject:director", title: "bsc plan needs --since" },
    ]);
    expect(d.rawNodes.find((n) => n.id === "debugger-req-7")?.slug).toBe("debug - bsc plan needs --since");
    // "from depends on to": the director is blocked on the fix, matching the studio graph, where
    // buildOrgFleetData reverses every org relationship into the same shape.
    expect(d.rawEdges).toContainEqual({ from: "director", to: "debugger-req-7", kind: "api" });
  });

  it("ignores requests from ANOTHER project's director, and from a studio session", () => {
    // Scoping is the whole risk here: every project drill sees the same global request list, so an
    // unscoped match would draw one director's request into every other project's graph.
    const d = withProjectRequestNodes(drill(), "myproject", [
      { id: 8, origin: "otherproject:director", title: "not mine" },
      { id: 9, origin: designerSessionId("react"), title: "the studio graph owns this one" },
    ]);
    expect(d.rawNodes.some((n) => n.id.startsWith("debugger-req-"))).toBe(false);
  });

  it("is a no-op with no requests, no project key, or no director drawn", () => {
    const base = drill();
    expect(withProjectRequestNodes(base, "myproject", [])).toBe(base);
    expect(withProjectRequestNodes(base, "", [{ id: 7, origin: "myproject:director", title: "x" }])).toBe(base);
    // A drill with no director node has nothing to hang the request off — skip rather than orphan it.
    const noDirector: GlanceData = { ...base, rawNodes: base.rawNodes.filter((n) => n.id !== "director") };
    expect(withProjectRequestNodes(noDirector, "myproject", [{ id: 7, origin: "myproject:director", title: "x" }]))
      .toBe(noDirector);
  });

  it("is idempotent — a re-render must not double the node", () => {
    const reqs = [{ id: 7, origin: "myproject:director", title: "x" }];
    const once = withProjectRequestNodes(drill(), "myproject", reqs);
    const twice = withProjectRequestNodes(once, "myproject", reqs);
    expect(twice.rawNodes.filter((n) => n.id === "debugger-req-7")).toHaveLength(1);
  });
});

describe("studioNodeHome (#glance-resume / #3357)", () => {
  // The bare `debugger` node has NO home any more (#debug-nodes-hang-off-the-session-that-filed-them):
  // the standing session it opened is gone. Its per-request successors have one — asserted below, where
  // the request-session cases live.
  it("has no home for the retired standing debugger node", () => {
    expect(studioNodeHome("debugger")).toBeNull();
  });

  it("sends EVERY studio session to the in-graph morph now that they live on TerminalHost (#3357)", () => {
    // Before #3357 the designer/librarian/architect ran their own single-mount xterm (`useScreenSession`),
    // which the host could not re-parent — so opening one had to navigate to its workspace page. They are
    // now TerminalHost-hosted like the debugger, so the graph morphs the node into the live terminal
    // instead of throwing the user onto another page.
    for (const id of ["designer-react", "librarian-rust", "architect"]) {
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
  const none = { paneClaudeActive: {}, paneStatus: {} };

  // The `debugger` special case is GONE with the standing node
  // (#debug-nodes-hang-off-the-session-that-filed-them). It read liveness off the Settings FLAG, which
  // answered "is the toggle on", not "is a session running" — every other node has always been judged
  // by its own pane, and now every node is.
  it("has no flag-driven special case left — liveness is a pane question for every node", () => {
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
    expect(studioSessionLive("library", { ...none })).toBe(false);
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

  // The bug this test NAME described for its whole life while its assertion said the opposite: both the
  // unmounted and the mounted-quiet branch returned `off`, so a studio the user was actively talking to
  // rendered dark unless `paneStatus` happened to read `run` at that instant. `healthy · idle` is what
  // the fleet twin settled on in #4042 for the identical question — health is the EXISTENCE axis,
  // activity is the WORK axis, and collapsing them threw away the only signal that separates a running
  // studio from one that was never launched.
  it("a MOUNTED but quiet studio reads healthy · idle — the session exists, it just is not working", () => {
    const r = of([node("designer-react")], sig({ paneClaudeActive: { [designerSessionId("react")]: true } }));
    expect(r).toEqual({ "designer-react": { health: "healthy", activity: "idle" } });
  });

  // The three states, side by side, off ONE signal each — so a future edit cannot quietly merge two of
  // them again. This is the assertion the old pair was missing: nothing compared quiet against unmounted.
  it("separates the three states: unmounted vs mounted-quiet vs working", () => {
    const sid = designerSessionId("react");
    expect(of([node("designer-react")], sig())["designer-react"])
      .toEqual({ health: "off", activity: "idle" });
    expect(of([node("designer-react")], sig({ paneStatus: { [sid]: "on" } }))["designer-react"])
      .toEqual({ health: "healthy", activity: "idle" });
    expect(of([node("designer-react")], sig({ paneStatus: { [sid]: "run" } }))["designer-react"])
      .toEqual({ health: "healthy", activity: "building" });
  });

  // A request session's node is a normal node here, and it is the one that most needs to stop reading
  // `off`: these sessions are started BY the app, so a dark node is the difference between a supervised
  // background session and an invisible one.
  it("a live request session's node reports live, exactly like a studio's", () => {
    const r = of([node("debugger-req-96")], sig({ paneClaudeActive: { "debug-studio:req-96": true } }));
    expect(r["debugger-req-96"]).toEqual({ health: "healthy", activity: "idle" });
    const working = of([node("debugger-req-96")], sig({ paneStatus: { "debug-studio:req-96": "run" } }));
    expect(working["debugger-req-96"]).toEqual({ health: "healthy", activity: "building" });
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
    expect(r["librarian-rust"]).toEqual({ health: "healthy", activity: "building" });
    // Still `off` — not merely un-building. The other two have NO session, which is a different fact
    // from the quiet-but-live one above, and this is where that separation has to hold.
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
    // The standing session's node resolves to NOTHING now — it is retired, and a node id that still
    // mapped to a pane would keep a dead session openable.
    expect(studioPaneIdForNode("debugger")).toBeNull();
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

// ── withStudioSessions (#the-app-drills-into-a-project-that-was-deleted) ─────────────────────────────
describe("withStudioSessions — the app's sessions fold into its project's drill", () => {
  const fleetNode = (id: string) => ({ id, slug: id, role: "service" as const, roleLabel: "worker", health: "off" as const, activity: "idle" as const });
  const fleet = (ids: string[]): GlanceData => ({
    rawNodes: ids.map(fleetNode),
    rawEdges: [],
    sample: false,
  });

  it("adds the app-owned SESSIONS beside the project's own workers", () => {
    const out = withStudioSessions(fleet(["cli-platform", "console"]), BUILTIN_ORGS, BUILTIN_PERSONAS, []);
    const ids = out.rawNodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["cli-platform", "console", "designer", "librarian", "architect"]));
    // Every folded node opens something. A node that draws and does nothing is the failure mode this
    // codebase keeps rediscovering, so the fold is defined as "resolves to an app-owned pane".
    const folded = ids.filter((id) => !["cli-platform", "console"].includes(id));
    for (const id of folded) expect(studioPaneIdForNode(id)).not.toBeNull();
  });

  it("folds NO library/resource node — they collide with real stream ids and have their own L0 band", () => {
    const out = withStudioSessions(fleet([]), BUILTIN_ORGS, BUILTIN_PERSONAS, []);
    const ids = out.rawNodes.map((n) => n.id);
    // The studio team names its libraries for domains the app's own fleet also has streams for.
    expect(ids).not.toContain("algorithms");
    expect(ids).not.toContain("sounds");
    expect(ids).not.toContain("integrations");
    // …and the `planner` position has no fixed session, so it would draw a node that does nothing.
    expect(ids).not.toContain("planner");
  });

  it("a fleet stream that SHARES a studio node's id keeps its own node — the fleet owns its drill", () => {
    // Same name, different thing. Merging over it would hand a worker a studio's identity; skipping is
    // the honest degradation, and the edge rule below stops the skip from leaving a dangling claim.
    const out = withStudioSessions(fleet(["designer"]), BUILTIN_ORGS, BUILTIN_PERSONAS, []);
    expect(out.rawNodes.filter((n) => n.id === "designer")).toHaveLength(1);
    expect(out.rawNodes.find((n) => n.id === "designer")!.roleLabel).toBe("worker");
  });

  it("keeps an edge only when BOTH ends were folded", () => {
    // With `designer` skipped as a collision, the designer↔librarian edge must NOT be drawn — it would
    // assert a studio relationship about a fleet worker that happens to share the name.
    const out = withStudioSessions(fleet(["designer"]), BUILTIN_ORGS, BUILTIN_PERSONAS, []);
    expect(out.rawEdges.some((e) => e.from === "designer" || e.to === "designer")).toBe(false);
  });

  it("carries the live request sessions in, edged to the session that filed them", () => {
    const out = withStudioSessions(fleet(["cli-platform"]), BUILTIN_ORGS, BUILTIN_PERSONAS, [
      { id: 96, origin: designerSessionId("react"), title: "ui remove does not stick" },
      { id: 93, origin: null, title: "navigate times out" },
    ]);
    const ids = out.rawNodes.map((n) => n.id);
    expect(ids).toContain("debugger-req-96");
    // The origin-less one too — nothing else can host it, so dropping it here hides a running session.
    expect(ids).toContain("debugger-req-93");
    expect(out.rawEdges).toContainEqual(expect.objectContaining({ from: "designer", to: "debugger-req-96" }));
    expect(out.rawEdges.some((e) => e.from === "debugger-req-93" || e.to === "debugger-req-93")).toBe(false);
  });

  it("is idempotent — folding twice never doubles a node", () => {
    const once = withStudioSessions(fleet(["console"]), BUILTIN_ORGS, BUILTIN_PERSONAS, []);
    const twice = withStudioSessions(once, BUILTIN_ORGS, BUILTIN_PERSONAS, []);
    expect(twice.rawNodes).toHaveLength(once.rawNodes.length);
    expect(twice.rawEdges).toHaveLength(once.rawEdges.length);
  });

  it("returns the graph UNTOUCHED when the Studio Network team is absent", () => {
    const base = fleet(["console"]);
    expect(withStudioSessions(base, [], BUILTIN_PERSONAS, [])).toBe(base);
  });

  it("preserves the fleet graph's own fields", () => {
    const base = { ...fleet(["console"]), sample: true };
    expect(withStudioSessions(base, BUILTIN_ORGS, BUILTIN_PERSONAS, []).sample).toBe(true);
  });
});
