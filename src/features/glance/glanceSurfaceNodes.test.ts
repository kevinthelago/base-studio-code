// The surface-node PROJECTION (`epic-command-surfaces-are-nodes`, slice 1) — the crate roster from
// `bsc surface crates --json` becomes Glance nodes and crate-dependency edges.
//
// The corpus is shaped like the real roster: 54 workspace members of which 37 expose verbs and 17 do
// not, `bsc-util` among the verbless ones. Every assertion here is about a decision that could
// plausibly have gone the other way, and would have been wrong in a way the UI would not reveal.
import { describe, it, expect } from "vitest";
import { surfaceGraph, withSurfaceNodes, crateKind, crateDrillGraph, CRATE_KIND_ROLE, type SurfaceRosterRow, type CrateDrillDoc } from "@/features/glance/lib/surfaceNodes";
import { buildGlanceData, type GlanceData } from "@/features/glance/lib/glanceData";
import { buildGraph } from "@/features/glance/lib/glanceGraph";
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

  it("leaves them UNBANDED so they flow with the graph", () => {
    const { nodes } = surfaceGraph(ROSTER);
    // REVERSED 2026-09-02 — see "crates are ordinary nodes" below; a crate flows with the graph.
    for (const n of nodes) expect(isBandNode(n), n.id).toBe(false);
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

  // REPLACED 2026-09-02: the guarantee is no longer "one edge per dep" but "reachability preserved".
  //
  // Edges are transitively reduced now (the drill lagged at 230 of them), so `plandb -> bsc-util` is
  // deliberately ABSENT — plandb reaches bsc-util through bsc-cli-util, and the direct line restated
  // what the path already showed. Asserting the edge count would pin the wrong property; asserting
  // reachability pins the one that actually matters to a reader following the graph.
  it("preserves REACHABILITY while drawing fewer lines than there are deps", () => {
    const { edges } = surfaceGraph(ROSTER);
    expect(edges.every((e) => e.kind === "depends-on")).toBe(true);
    for (const e of edges) expect(isBandEdge(e.kind), e.kind).toBe(false);

    const declared = ROSTER.reduce((n, r) => n + r.dependsOn.length, 0);
    expect(edges.length).toBeLessThan(declared);

    // plandb still REACHES bsc-util, just not directly — which is the whole claim of a reduction.
    const out = new Map<string, string[]>();
    for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    const reaches = (from: string, to: string): boolean => {
      const seen = new Set<string>([from]);
      const stack = [from];
      while (stack.length) {
        const u = stack.pop() as string;
        for (const v of out.get(u) ?? []) {
          if (v === to) return true;
          if (!seen.has(v)) { seen.add(v); stack.push(v); }
        }
      }
      return false;
    };
    expect(reaches(surfaceNodeId("plandb"), surfaceNodeId("bsc-util"))).toBe(true);
    expect(edges.some((e) => e.from === surfaceNodeId("plandb") && e.to === surfaceNodeId("bsc-util"))).toBe(false);
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

  // "counts dependents" MOVED TO RUST. `bsc surface drill` computes `dependentCount` and ships it on
  // `CrateDrillDoc`; its cases (3 for a load-bearing util, 0 for a leaf, and a self-edge not inflating
  // the count) are asserted in `crates/bsc/src/main.rs`. The TypeScript copy answered the same question
  // twice and had no caller but this test.
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

// ---------------------------------------------------------------------------------------------
// CRATES FLOW IN THE GRAPH — they are not fenced into the band.
//
// MAINTAINER, 2026-09-02: "lets treat these like normal nodes, instead of placing them in a box.
// they should flow within the graph."
//
// The same correction `architect-sits-with-the-projects` made, for the same reason. The band is for a
// shared DEPENDENCY the projects consume — a kit, an algorithm, an MCP server — where lifting keeps its
// health out of a project's roll-up. A crate is not consumed by the project; it IS the project,
// decomposed. Fencing 60 of them renders an inventory beside the work rather than the work.
// ---------------------------------------------------------------------------------------------
describe("crates are ordinary nodes, not band nodes", () => {
  it("a surface node is not banded, and its depends-on edge is not a band edge", () => {
    const { nodes, edges } = surfaceGraph(ROSTER);
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) expect(isBandNode(n)).toBe(false);
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) expect(isBandEdge(e.kind)).toBe(false);
  });

  it("the band still holds the kinds that DO belong in it", () => {
    // Un-fencing crates must not un-fence the dimensions the band exists for — the failure mode the
    // architect change had to guard too.
    for (const kind of ["mcp", "service", "integration"] as const) {
      expect(isBandNode({ kind })).toBe(true);
    }
    for (const kind of ["uses-mcp", "uses-service", "uses-integration"] as const) {
      expect(isBandEdge(kind)).toBe(true);
    }
  });

  it("the crate graph is ACYCLIC, which is what makes admitting it to the network safe", () => {
    // A cycle in this graph has blanked it before (glance-planner-edge-isolation), and the architect
    // was only safe to un-fence because it is a sink. A crate is not a sink, so the safety argument has
    // to be the DAG — asserted here rather than assumed, over the real projection.
    const { nodes, edges } = surfaceGraph(ROSTER);
    const out = new Map(nodes.map((n) => [n.id, [] as string[]]));
    for (const e of edges) out.get(e.from)?.push(e.to);
    const state = new Map<string, number>();
    const walk = (u: string): boolean => {
      state.set(u, 1);
      for (const v of out.get(u) ?? []) {
        if (state.get(v) === 1) return true;
        if (!state.has(v) && walk(v)) return true;
      }
      state.set(u, 2);
      return false;
    };
    for (const n of nodes) if (!state.has(n.id) && walk(n.id)) throw new Error("cycle in the crate graph");
    expect(state.size).toBe(nodes.length);
  });
});

// ---------------------------------------------------------------------------------------------
// REPO SEPARATION + EDGE VOLUME (`crates-keep-their-repo-and-stop-drawing-implied-edges`).
//
// MAINTAINER, 2026-09-02, on the un-banded first cut: "we're now no longer separating between repos …
// this really jumbled our graph. we're also drawing a ton more lines here so we're experiencing lag."
//
// Both were caused by un-fencing. The fence had been doing the repo separation by accident, and it had
// also been hiding how many `depends-on` lines there are.
// ---------------------------------------------------------------------------------------------
describe("crates stay separated by repository", () => {
  const withRepo = (ids: string[], repo?: string): GlanceData => ({
    rawNodes: ids.map((id) => ({
      id, slug: id, kind: "project" as const, role: "service" as const,
      health: "off" as const, activity: "idle" as const, ...(repo ? { repo } : {}),
    })),
    rawEdges: [],
    sample: false,
  });

  it("stamps every crate with the repo the drill's own streams carry", () => {
    const out = withSurfaceNodes(withRepo(["design-studio", "fleet"], "acme/base-studio-code"), ROSTER);
    const crates = out.rawNodes.filter((n) => n.kind === "surface");
    expect(crates.length).toBeGreaterThan(0);
    // Every one, not most — `bandNodesByRepo` leaves an unstamped node UNGROUPED, which is exactly the
    // scattering this fixes.
    for (const c of crates) expect(c.repo).toBe("acme/base-studio-code");
  });

  it("takes the MODAL repo, so one odd node cannot capture the whole roster", () => {
    const data: GlanceData = {
      rawNodes: [
        ...withRepo(["a", "b", "c"], "acme/main").rawNodes,
        ...withRepo(["d"], "acme/other").rawNodes,
      ],
      rawEdges: [], sample: false,
    };
    const out = withSurfaceNodes(data, ROSTER);
    for (const c of out.rawNodes.filter((n) => n.kind === "surface")) expect(c.repo).toBe("acme/main");
  });

  it("leaves crates UNSTAMPED when no repo is knowable, rather than inventing one", () => {
    // Ungrouped is honest; a wrong band is not.
    const out = withSurfaceNodes(withRepo(["a", "b"]), ROSTER);
    for (const c of out.rawNodes.filter((n) => n.kind === "surface")) expect(c.repo).toBeUndefined();
  });
});

describe("only the edges that are not already implied get drawn", () => {
  it("drops an edge a longer path already expresses", () => {
    // a → b → c, plus a redundant a → c. The direct a→c must go; reachability is unchanged.
    const r: SurfaceRosterRow[] = [
      { crate: "a", path: "crates/a", surface: false, verbs: [], dependsOn: ["b", "c"] },
      { crate: "b", path: "crates/b", surface: false, verbs: [], dependsOn: ["c"] },
      { crate: "c", path: "crates/c", surface: false, verbs: [], dependsOn: [] },
    ];
    const { edges } = surfaceGraph(r);
    const pairs = edges.map((e) => `${e.from}->${e.to}`).sort();
    expect(pairs).toEqual([
      `${surfaceNodeId("a")}->${surfaceNodeId("b")}`,
      `${surfaceNodeId("b")}->${surfaceNodeId("c")}`,
    ]);
  });

  it("keeps an edge that is the ONLY path — a reduction must not lose reachability", () => {
    const r: SurfaceRosterRow[] = [
      { crate: "a", path: "crates/a", surface: false, verbs: [], dependsOn: ["b"] },
      { crate: "b", path: "crates/b", surface: false, verbs: [], dependsOn: [] },
    ];
    expect(surfaceGraph(r).edges).toHaveLength(1);
  });

  it("collapses a hub — the specific shape that caused the lag", () => {
    // Every crate depends on `util` directly AND through `cli`. The direct lines are all implied, so a
    // hub with N dependents draws far fewer than N. This is `bsc-util`'s 44 → 5 in miniature.
    const r: SurfaceRosterRow[] = [
      { crate: "util", path: "p", surface: false, verbs: [], dependsOn: [] },
      { crate: "cli", path: "p", surface: false, verbs: [], dependsOn: ["util"] },
      ...["x", "y", "z", "w"].map((c) => ({
        crate: c, path: "p", surface: false, verbs: [], dependsOn: ["cli", "util"],
      })),
    ];
    const { edges } = surfaceGraph(r);
    const intoUtil = edges.filter((e) => e.to === surfaceNodeId("util"));
    expect(intoUtil).toHaveLength(1); // only cli → util survives; the four direct lines are implied
    expect(edges).toHaveLength(5);
  });

  it("terminates on a malformed CYCLIC roster instead of hanging the cockpit", () => {
    const r: SurfaceRosterRow[] = [
      { crate: "a", path: "p", surface: false, verbs: [], dependsOn: ["b"] },
      { crate: "b", path: "p", surface: false, verbs: [], dependsOn: ["a"] },
    ];
    expect(() => surfaceGraph(r)).not.toThrow();
    expect(surfaceGraph(r).nodes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// THE THREE KINDS OF CRATE (`a-crate-node-shows-which-of-the-three-kinds-it-is`).
//
// MAINTAINER 2026-09-02: "take a look at the crate nodes and lets create a visual distinction between
// the 3 different kinds we have."
//
// The axis is HOW YOU USE IT, which is what a reader of this graph is asking: call it (`bsc <verb>`),
// build on it, or run it. Measured on the real roster: 43 surface / 14 library / 3 program of 60.
// ---------------------------------------------------------------------------------------------
describe("a crate node says which of the three kinds it is", () => {
  const row2 = (crate: string, surface: boolean, deps: string[] = []): SurfaceRosterRow => ({
    crate, path: `crates/${crate}`, surface, verbs: surface ? ["v"] : [], dependsOn: deps,
  });

  it("classifies on VERBS then FAN-IN — never on the name", () => {
    // The trap, stated as a test: `bsc-agent` and `bsc-hook` read as libraries and are programs;
    // `channel` and `research` read as programs and are libraries. A name heuristic gets four of
    // seventeen wrong, silently, which is why fan-in is the discriminator.
    expect(crateKind(row2("plandb", true), 0)).toBe("surface");
    expect(crateKind(row2("bsc-util", false), 44)).toBe("library");
    expect(crateKind(row2("bsc-agent", false), 0)).toBe("program");
    // a verb WINS over fan-in — a crate you can call is a surface however many depend on it
    expect(crateKind(row2("logs", true), 12)).toBe("surface");
  });

  it("gives each kind its own colour AND its own word", () => {
    // Colour alone is a cipher: it dies in greyscale, in a screenshot, and for a colour-blind reader.
    // The caption is what makes the distinction legible without the legend.
    const r = [row2("cli", true), row2("util", false, []), row2("app", false, [])];
    r[0].dependsOn = ["util"]; // so `util` has a dependent and `app` does not
    const { nodes } = surfaceGraph(r);
    const by = (c: string) => nodes.find((n) => n.slug === c);
    expect(by("cli")?.roleLabel).toBe("surface");
    expect(by("util")?.roleLabel).toBe("library");
    expect(by("app")?.roleLabel).toBe("program");
    const roles = [by("cli")?.role, by("util")?.role, by("app")?.role];
    expect(new Set(roles).size).toBe(3); // three kinds, three accents — none collides
  });

  it("is exhaustive and disjoint — every crate gets exactly one kind", () => {
    const { nodes } = surfaceGraph(ROSTER);
    const kinds = nodes.map((n) => n.roleLabel);
    expect(kinds.every((k) => k === "surface" || k === "library" || k === "program")).toBe(true);
    expect(kinds).toHaveLength(ROSTER.length);
  });

  it("maps every kind to a role, so the legend can never be handed an unknown one", () => {
    for (const k of ["surface", "library", "program"] as const) {
      expect(CRATE_KIND_ROLE[k], `${k} has no accent`).toBeTruthy();
    }
    expect(Object.keys(CRATE_KIND_ROLE).sort()).toEqual(["library", "program", "surface"]);
  });
});

// ---------------------------------------------------------------------------------------------
// THE SECOND LAYER (`a-crate-node-drills-into-its-verbs`).
//
// MAINTAINER: a crate node should "navigate into a second layer which will present the user the
// surface node and their related verbs". So this is a GRAPH, not an inspector panel.
// ---------------------------------------------------------------------------------------------
describe("a crate drills into its NOUNS, each rooting its verbs", () => {
  const doc = (over: Partial<CrateDrillDoc> = {}): CrateDrillDoc => ({
    crate: "logs", path: "crates/logs", surface: true,
    nouns: [
      { noun: "logs", status: "active", catalog: "projected", verbs: [
        { verb: "sessions", summary: "s", usage: "u" },
        { verb: "summary", summary: "s", usage: "u" },
      ] },
      { noun: "metrics", status: "active", catalog: "unreachable", verbs: null },
      { noun: "perf", status: "active", catalog: "projected", verbs: [{ verb: "summary", summary: "s", usage: "u" }] },
    ],
    dependsOn: ["bsc-util"], dependents: ["bsc-fleet"], dependentCount: 1,
    ...over,
  });

  it("roots on the NOUN, not the crate — a multi-noun crate is a forest", () => {
    // You run `bsc logs sessions`, not `bsc logs-crate sessions`. Rooting on the crate flattened three
    // separate commands into one fan and lost the thing the reader is navigating.
    const g = crateDrillGraph(doc());
    const roots = g.rawNodes.filter((n) => n.id.startsWith("noun:"));
    expect(roots.map((n) => n.slug).sort()).toEqual(["logs", "metrics", "perf"]);
    // no crate node while there are nouns — the drill is already scoped to it
    expect(g.rawNodes.some((n) => n.id === surfaceNodeId("logs"))).toBe(false);
    // EVERY EDGE POINTS AT THE NOUN, and that is what puts the noun on the LEFT.
    //
    // `layoutProjectNetwork` hands `layerDag` the edges reversed and lays layers out left→right, so an
    // edge's TARGET lands at a lower layer — further left. Drawn `noun → verb` the verbs sat left of
    // their own noun, which is backwards to read. This assertion is the layout, not a formality.
    for (const e of g.rawEdges) {
      expect(e.to.startsWith("noun:"), `${e.id} must point AT its noun`).toBe(true);
      expect(e.from.startsWith("verb:"), `${e.id} must start at a verb`).toBe(true);
      expect(e.kind).toBe("verb-of");
    }
    expect(g.rawEdges).toHaveLength(3);
  });

  it("LAYS THE NOUN LEFT OF ITS VERBS — the property, not a proxy for it", () => {
    // MAINTAINER: "information is, in the west, read from left to right! lets please place the noun on
    // the left hand side and their verbs to the right."
    //
    // Asserting edge DIRECTION only pins the current layering convention ("the target sits at a lower
    // layer"). Asserting POSITION pins what was actually asked for, and survives that convention
    // changing underneath — which is the whole reason the direction had to be flipped in the first
    // place. This runs the real layout engine, not a stand-in.
    const g = crateDrillGraph(doc());
    const m = buildGraph(g.rawNodes, g.rawEdges);
    const at = (id: string) => m.nodes.find((n) => n.id === id)!;
    const logsRoot = at("noun:logs");
    for (const v of ["sessions", "summary"]) {
      const verb = m.nodes.find((n) => n.slug === v && n.roleLabel === "logs")!;
      expect(verb.x, `bsc logs ${v} must sit RIGHT of its noun`).toBeGreaterThan(logsRoot.x);
    }
  });

  it("DRAWS a noun whose catalog is unreachable, rather than hiding the command", () => {
    // Reversed from the crate-rooted cut on purpose: `bsc metrics` EXISTS and has no verb catalog, and
    // a reader asking "what can I run" needs to see it. Rooted on the crate it would have asserted the
    // crate offered something it did not; rooted on the noun it states a fact.
    const g = crateDrillGraph(doc());
    const metrics = g.rawNodes.find((n) => n.slug === "metrics");
    expect(metrics).toBeTruthy();
    expect(g.rawEdges.filter((e) => e.to === metrics!.id)).toHaveLength(0);
  });

  it("keys a verb on its NOUN, so two nouns' same-named verbs stay distinct", () => {
    const g = crateDrillGraph(doc());
    expect(g.rawNodes.filter((n) => n.slug === "summary")).toHaveLength(2);
    const ids = g.rawNodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(g.rawNodes.filter((n) => n.slug === "summary").map((n) => n.roleLabel).sort()).toEqual(["logs", "perf"]);
  });

  it("captions each noun root with its CRATE, so the reader keeps that fact", () => {
    const g = crateDrillGraph(doc());
    expect(g.rawNodes.find((n) => n.slug === "logs" && n.id.startsWith("noun:"))?.roleLabel).toBe("logs");
    expect(g.rawNodes.find((n) => n.slug === "perf")?.roleLabel).toBe("logs");
  });

  it("falls back to the crate node when there is nothing to call", () => {
    // A library or a program must not render as a blank canvas, which reads as a failed load.
    const g = crateDrillGraph(doc({ crate: "bsc-util", surface: false, nouns: [], dependentCount: 44 }));
    expect(g.rawNodes).toHaveLength(1);
    expect(g.rawNodes[0].id).toBe(surfaceNodeId("bsc-util"));
    expect(g.rawNodes[0].roleLabel).toBe("library");
    expect(g.rawEdges).toHaveLength(0);
  });
});
