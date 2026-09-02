// The surface-node PROJECTION (`epic-command-surfaces-are-nodes`, slice 1) — the crate roster from
// `bsc surface crates --json` becomes Glance nodes and crate-dependency edges.
//
// The corpus is shaped like the real roster: 54 workspace members of which 37 expose verbs and 17 do
// not, `bsc-util` among the verbless ones. Every assertion here is about a decision that could
// plausibly have gone the other way, and would have been wrong in a way the UI would not reveal.
import { describe, it, expect } from "vitest";
import { surfaceGraph, dependentCount, withSurfaceNodes, type SurfaceRosterRow } from "@/features/glance/lib/surfaceNodes";
import { buildGlanceData, type GlanceData } from "@/features/glance/lib/glanceData";
import { surfaceNodeId, isBandNode, isBandEdge } from "@/features/glance/lib/glanceGraph";

const row = (crate: string, dependsOn: string[] = [], verbs: string[] = []): SurfaceRosterRow => ({
  crate, path: `crates/${crate}`, surface: verbs.length > 0, verbs, dependsOn,
});

/** A miniature of the real workspace: a verbless util everything leans on, plus verb-bearing crates. */
const ROSTER: SurfaceRosterRow[] = [
  row("bsc-util"),
  row("bsc-cli-util", ["bsc-util"]),
  row("plandb", ["bsc-util", "bsc-cli-util"], ["plan"]),
  row("logs", ["bsc-util"], ["logs", "metrics", "perf"]),
  row("bsc", ["plandb", "logs", "bsc-cli-util"], ["surface", "version"]),
];

describe("the surface-node projection", () => {
  it("gives EVERY crate a node, including the ones with no verbs", () => {
    const { nodes } = surfaceGraph(ROSTER);
    expect(nodes).toHaveLength(ROSTER.length);
    // The whole point of the crate-keyed decision: bsc-util has no verb and is the crate whose
    // change reaches most of the workspace, so it is exactly the one that must have an owner.
    expect(nodes.map((n) => n.id)).toContain(surfaceNodeId("bsc-util"));
  });

  it("marks them as band nodes so they render in the fenced band", () => {
    const { nodes } = surfaceGraph(ROSTER);
    for (const n of nodes) expect(isBandNode(n), n.id).toBe(true);
  });

  it("says NO SIGNAL rather than claiming healthy", () => {
    // A crate has no health measurement yet. `healthy` would assert something nobody measured, and
    // the dot is supposed to mean something.
    const { nodes } = surfaceGraph(ROSTER);
    for (const n of nodes) {
      expect(n.health, `${n.id} must not claim a health nobody measured`).toBe("off");
      expect(n.activity).toBe("idle");
    }
  });

  it("draws one crate-dependency edge per internal dep, in the band", () => {
    const { edges } = surfaceGraph(ROSTER);
    expect(edges).toHaveLength(ROSTER.reduce((n, r) => n + r.dependsOn.length, 0));
    for (const e of edges) expect(isBandEdge(e.kind), e.kind).toBe(true);
    expect(edges.every((e) => e.kind === "depends-on")).toBe(true);
    expect(edges.some((e) => e.from === surfaceNodeId("plandb") && e.to === surfaceNodeId("bsc-util"))).toBe(true);
  });

  /** A dangling edge is worse than a missing one — the layout would carry an id nothing renders. */
  it("drops an edge to a crate that is not in the roster", () => {
    const { nodes, edges } = surfaceGraph([row("a", ["not-a-member", "b"]), row("b")]);
    const ids = new Set(nodes.map((n) => n.id));
    expect(edges).toHaveLength(1);
    for (const e of edges) {
      expect(ids.has(e.from), `${e.from} must be a real node`).toBe(true);
      expect(ids.has(e.to), `${e.to} must be a real node`).toBe(true);
    }
  });

  it("never draws a self-loop, even from a malformed roster", () => {
    const { edges } = surfaceGraph([row("a", ["a"])]);
    expect(edges).toEqual([]);
  });

  it("deduplicates a repeated dependency", () => {
    const { edges } = surfaceGraph([row("a", ["b", "b"]), row("b")]);
    expect(edges).toHaveLength(1);
  });

  it("is empty for an empty roster, without throwing", () => {
    expect(surfaceGraph([])).toEqual({ nodes: [], edges: [] });
  });

  /** The number that makes the node worth drawing: what touching this crate reaches. */
  it("counts dependents, which is what says a util crate is load-bearing", () => {
    expect(dependentCount(ROSTER, "bsc-util")).toBe(3);
    expect(dependentCount(ROSTER, "bsc")).toBe(0);
    // A crate listing itself must not inflate its own count.
    expect(dependentCount([row("a", ["a"])], "a")).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// THE DRILL FOLD (`the-surface-band-is-projected-but-never-drawn`).
//
// The projection above was landed by slice 1 and NOTHING CALLED IT — `surfaceGraph(` occurred exactly
// once in the tree, its own definition — so every crate node was provably absent from the running app
// while the item read `verified` and this file was green. These assertions are about the FOLD, which is
// the part that makes a node appear.
// ---------------------------------------------------------------------------------------------
describe("folding the surface band into a drill", () => {
  const data = (ids: string[] = []): GlanceData => ({
    rawNodes: ids.map((id) => ({ id, slug: id, kind: "project" as const, role: "service" as const, health: "off" as const, activity: "idle" as const })),
    rawEdges: [],
    sample: false,
  });

  it("adds a node per crate, and the depends-on edges that give the band structure", () => {
    const out = withSurfaceNodes(data(["studio-code"]), ROSTER);
    const added = out.rawNodes.filter((n) => n.kind === "surface");
    expect(added.map((n) => n.slug).sort()).toEqual(ROSTER.map((r) => r.crate).sort());
    // The EDGES are the whole difference from the removed L0 band, which drew none and left an
    // unconnected inventory. A fold that added nodes and dropped edges would repeat it exactly.
    expect(out.rawEdges.length).toBeGreaterThan(0);
    expect(out.rawEdges.every((e) => e.kind === "depends-on")).toBe(true);
    // and the host node it was folded into survives
    expect(out.rawNodes.some((n) => n.id === "studio-code")).toBe(true);
  });

  it("returns the graph UNCHANGED on an empty roster, rather than blanking the band", () => {
    const before = data(["studio-code"]);
    const after = withSurfaceNodes(before, []);
    // Identity, not just equality: a failed read must be a no-op, and re-deriving would drop the
    // reference the memo above it is keyed on.
    expect(after).toBe(before);
  });

  it("never draws a second node for a crate already in the graph", () => {
    const existing = surfaceNodeId(ROSTER[0].crate);
    const out = withSurfaceNodes(data([existing]), ROSTER);
    expect(out.rawNodes.filter((n) => n.id === existing)).toHaveLength(1);
  });

  it("drops an edge whose other end is not drawn, rather than dangling it", () => {
    // A roster of one crate that depends on a crate absent from the roster: the node lands, the edge
    // must not, or the layout carries an id nothing renders.
    const lone: SurfaceRosterRow[] = [
      { crate: "logs", path: "crates/logs", surface: true, verbs: ["logs"], dependsOn: ["not-in-roster"] },
    ];
    const out = withSurfaceNodes(data(), lone);
    expect(out.rawNodes.filter((n) => n.kind === "surface")).toHaveLength(1);
    expect(out.rawEdges).toHaveLength(0);
  });
});

// L0 MUST STAY FREE OF SURFACE NODES. An L0 band was built, shipped and REMOVED — one node per `bsc`
// subcommand with no edge, 33 unconnected marks beside the project network — and `glanceData`'s comment
// says the `surfaces` parameter was deleted rather than kept and ignored so that a later reader would
// not put it back. This is that guard, since a comment cannot fail a build.
describe("L0 draws no command surfaces", () => {
  it("buildGlanceData emits no node of kind `surface`", () => {
    const out = buildGlanceData([{ id: "studio-code", name: "studio-code" }]);
    // NOT VACUOUS: an empty graph would satisfy "contains no surface node" trivially, which is the
    // shape of every green-but-blind test this repo keeps getting caught by.
    expect(out.rawNodes.length).toBeGreaterThan(0);
    expect(out.rawNodes.some((n) => n.kind === "surface")).toBe(false);
    expect(out.rawEdges.some((e) => e.kind === "depends-on")).toBe(false);
  });
});
