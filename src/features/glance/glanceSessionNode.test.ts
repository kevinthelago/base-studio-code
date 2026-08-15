// #architect-node-expands-into-system-sessions — where the app-owned system sessions live.
//
// They used to be an L0 ROW to the architect's left, wired `architect → session`
// (#glance-reads-left-to-right-sessions-to-libraries). The maintainer's directive moved them INSIDE:
// the architect's node expands into them. So this file now pins two things at once — that L0 no longer
// draws them, and that the drill-in does — because a half-done move (removed from one place, not
// arriving in the other) is the failure that would leave the sessions unreachable from the graph
// entirely, with every "the node exists" test still green somewhere else.
//
// The left→right reading survives the move, minus one stop: architect → projects → libraries.
import { describe, it, expect } from "vitest";
import { buildGlanceData } from "./lib/glanceData";
import { buildArchitectFleetData } from "@/features/glance/lib/studioProject";
import { studioNetworkForArchitect, STUDIO_NETWORK_ID, ARCHITECT_NODE, BUILTIN_ORGS } from "@/features/teams";
import { buildGraph, architectNodeId, kitNodeId } from "./lib/glanceGraph";

const projects = [
  { id: "app-a", name: "App A" },
  { id: "app-b", name: "App B" },
];
const architect = [{ id: "persona-architect", name: "Team architect" }];
const build = (p = projects, a = architect) => buildGlanceData(p, [], [], [], [], [], a);

const studioTeam = () => BUILTIN_ORGS.find((t) => t.id === STUDIO_NETWORK_ID)!;

describe("L0 no longer carries the system sessions", () => {
  it("emits NO session node beside the architect", () => {
    const d = build();
    expect(d.rawNodes.filter((n) => n.kind === "session")).toHaveLength(0);
    expect(d.rawEdges.filter((e) => e.kind === "served-by")).toHaveLength(0);
  });

  it("still emits the ARCHITECT — it is the node that expands", () => {
    const d = build();
    const arch = d.rawNodes.find((n) => n.id === architectNodeId("persona-architect"));
    expect(arch).toBeTruthy();
    expect(arch!.kind).toBe("architect");
  });

  it("reads left→right end to end: architect → projects → libraries", () => {
    // The axis the L0 layout is FOR, minus the sessions stop. Still worth asserting as one chain: this
    // is what silently regresses if any remaining dimension's edge direction is flipped later.
    const d = buildGlanceData(
      projects, [], [{ projectKey: "app-a", kitId: "react-ui" }], [{ id: "react-ui", name: "React UI" }], [], [], architect,
    );
    const m = buildGraph(d.rawNodes, d.rawEdges);
    const x = (id: string) => m.nodes.find((n) => n.id === id)!.x;

    expect(x(architectNodeId("persona-architect"))).toBeLessThan(x("app-a"));
    expect(x("app-a")).toBeLessThan(x(kitNodeId("react-ui")));
    expect(x(kitNodeId("react-ui"))).toBeGreaterThanOrEqual(m.bandZone!.x0);
  });

  it("keeps the architect a SINK for provenance, with no cycle", () => {
    // `owned-by` points AT the architect. That is what stops a project↔architect cycle blanking the
    // graph (glance-planner-edge-isolation) — a cycle here takes the whole board down, so it is pinned
    // even though this item removed the edges that used to point the other way.
    const d = build();
    const m = buildGraph(d.rawNodes, d.rawEdges);
    const archId = architectNodeId("persona-architect");
    for (const e of m.edges.filter((x) => x.kind === "owned-by")) expect(e.to).toBe(archId);
    expect(m.cycleNodeIds.size).toBe(0);
  });
});

describe("the architect node expands into the sessions it commands", () => {
  it("narrows the Studio Network to the architect plus the sessions its verbs reach", () => {
    const t = studioNetworkForArchitect(studioTeam());
    const ids = t.positions.map((p) => p.nodeId);
    expect(ids[0]).toBe(ARCHITECT_NODE); // the hub comes first
    // #system-sessions-are-per-technology: the singular designer/librarian POSITIONS expand into one
    // node per technology, so the architect commands seven sessions rather than four.
    expect([...ids].sort()).toEqual([
      "architect",
      "designer-react", "designer-react-native",
      "integrator",
      "librarian-python", "librarian-rust", "librarian-typescript",
      "sound-designer",
    ]);
  });

  it("excludes what no architect verb can reach — the planner, the libraries, the debugger", () => {
    // The drill-in's whole claim is that it shows what the architect COMMANDS. A node it cannot start,
    // stop or ask would be a promise the verbs do not keep.
    const ids = new Set(studioNetworkForArchitect(studioTeam()).positions.map((p) => p.nodeId));
    // The un-teched role ids are absent too: they are ROLES, not sessions, since the split.
    for (const absent of ["planner", "debugger", "teams", "components", "algorithms", "designer", "librarian"]) {
      expect(ids.has(absent), `${absent} must not be in the architect's drill-in`).toBe(false);
    }
  });

  it("wires the architect to every session it commands — the L0 relationship, moved inside", () => {
    const t = studioNetworkForArchitect(studioTeam());
    expect(t.relationships).toHaveLength(7);
    for (const r of t.relationships) {
      expect(r.from).toBe(ARCHITECT_NODE);
      expect(r.to).not.toBe(ARCHITECT_NODE);
    }
    // Every edge lands on a position that is actually present — a dangling edge is what narrowing a
    // graph gets wrong.
    const ids = new Set(t.positions.map((p) => p.nodeId));
    for (const r of t.relationships) expect(ids.has(r.to)).toBe(true);
  });

  it("builds a real drilled graph through the SAME team adapter", () => {
    const d = buildArchitectFleetData(BUILTIN_ORGS, []);
    expect(d).toBeTruthy();
    const ids = d!.rawNodes.map((n) => n.id).sort();
    expect(ids).toEqual([
      "architect",
      "designer-react", "designer-react-native",
      "integrator",
      "librarian-python", "librarian-rust", "librarian-typescript",
      "sound-designer",
    ]);
    expect(d!.rawEdges).toHaveLength(7);
  });

  it("keeps the node ids that make a session OPENABLE — the morph path is unchanged", async () => {
    // `studioPaneIdForNode` maps a Studio Network POSITION id to its fixed app-owned pane id. If the
    // drill-in renamed its nodes, every session in it would stop opening — the graph would draw and do
    // nothing, which is the worst version of this change landing.
    const { studioPaneIdForNode, studioNodeHome } = await import("@/features/glance/lib/studioProject");
    const d = buildArchitectFleetData(BUILTIN_ORGS, [])!;
    for (const n of d.rawNodes) {
      expect(studioPaneIdForNode(n.id), `${n.id} resolves to a pane`).toBeTruthy();
      expect(studioNodeHome(n.id)?.kind, `${n.id} opens as a morph`).toBe("morph");
    }
  });

  it("is a NO-OP on a team that is not the Studio Network", () => {
    // The transform is exported, so a caller could hand it a user's own team. Narrowing that to five
    // positions would silently destroy their graph.
    const other = BUILTIN_ORGS.find((t) => t.id !== STUDIO_NETWORK_ID);
    if (!other) return;
    expect(studioNetworkForArchitect(other)).toBe(other);
  });
});
