// The surface-node PROJECTION (`epic-command-surfaces-are-nodes`, slice 1) — the crate roster from
// `bsc surface crates --json` becomes Glance nodes and crate-dependency edges.
//
// The corpus is shaped like the real roster: 54 workspace members of which 37 expose verbs and 17 do
// not, `bsc-util` among the verbless ones. Every assertion here is about a decision that could
// plausibly have gone the other way, and would have been wrong in a way the UI would not reveal.
import { describe, it, expect } from "vitest";
import { surfaceGraph, dependentCount, type SurfaceRosterRow } from "@/features/glance/lib/surfaceNodes";
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
