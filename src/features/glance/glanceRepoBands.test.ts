// REPOSITORY GROUPS (#nodes-are-grouped-by-repository) — a fleet drill stacks its nodes into one
// full-width horizontal band per repo, so a project with two codebases reads as two groups rather than
// one interleaved mass.
//
// This groups data that already exists: every fleet stream carries a `repo` and `bsc plan fleet set`
// validates it as required, so nothing new has to be maintained for the grouping to stay true. The gap
// it closes was purely that `repo` never reached the graph — `GRawNode` had no field for it.
//
// A SEPARATE FILE rather than appended to the record's carried test: `bsc graph tests set` was removed
// from the binary (the verb is now `tests harvest <dir>`, which carries a COLOCATED file onto its node),
// and `glanceGraph` has no file to colocate with. An on-disk test is the pattern the other record-backed
// glance modules already use.
import { describe, it, expect } from "vitest";
import { buildGraph, NW, NH, type GRawNode, type GRawEdge } from "@/features/glance/lib/glanceGraph";
import { withStreamRepos } from "@/features/glance/lib/glanceFleet";

const n = (id: string, repo?: string): GRawNode =>
  ({ id, role: "service", health: "off", activity: "idle", ...(repo ? { repo } : {}) });

const BASE = "kevinthelago/base-studio-code";
const MOBILE = "kevinthelago/mobile-studio-code";

describe("buildGraph — repository groups", () => {
  it("draws one band per repo, labelled with the BARE repo name", () => {
    const m = buildGraph([n("a", BASE), n("b", MOBILE)], []);
    // The owner is identical on every band in a project, so repeating it costs width and distinguishes
    // nothing — the band carries the full `owner/name` as its identity and prints only the name.
    expect(m.repoBands?.map((b) => b.label)).toEqual(["base-studio-code", "mobile-studio-code"]);
    expect(m.repoBands?.map((b) => b.repo)).toEqual([BASE, MOBILE]);
  });

  it("orders bands by FIRST APPEARANCE, not alphabetically", () => {
    // The plan's own stream order is roughly build order and is meaningful; sorting by name would
    // reshuffle it for no reason a reader could see.
    const m = buildGraph([n("a", MOBILE), n("b", BASE)], []);
    expect(m.repoBands?.map((b) => b.repo)).toEqual([MOBILE, BASE]);
  });

  it("puts every node inside its own band's zone, and the bands never overlap", () => {
    const m = buildGraph([n("a", "o/one"), n("b", "o/one"), n("c", "o/two")], []);
    const band = (repo: string) => m.repoBands!.find((b) => b.repo === repo)!;
    for (const node of m.nodes) {
      const b = band(node.repo!);
      expect(node.y).toBeGreaterThanOrEqual(b.y0);
      expect(node.y + NH).toBeLessThanOrEqual(b.y1);
    }
    expect(band("o/one").y1).toBeLessThan(band("o/two").y0);
  });

  it("puts the bands to the RIGHT of everything ungrouped, not below it", () => {
    // The architect, the peer directors, the system sessions and the debug sessions are project-scoped,
    // not repo-scoped. Filing one under a repo would be an invented fact, so they keep their own zone.
    //
    // BESIDE, not beneath — the first attempt stacked the bands under the tier, which implied the repos
    // hang off the architect the way a debug session hangs off its spawner. They are not subordinate to
    // it: the tier is who is working, the bands are the codebases they work in.
    const m = buildGraph([n("architect"), n("a", "o/one"), n("b", "o/two")], []);
    const arch = m.nodes.find((x) => x.id === "architect")!;
    for (const b of m.repoBands!) expect(b.x0).toBeGreaterThan(arch.x + NW);
    for (const node of m.nodes.filter((x) => x.repo)) expect(node.x).toBeGreaterThan(arch.x + NW);
  });

  it("starts the first band level with the top of the graph, so it reads beside the tier", () => {
    const m = buildGraph([n("architect"), n("a", "o/one"), n("b", "o/two")], []);
    const top = Math.min(...m.nodes.map((x) => x.y));
    expect(m.repoBands![0].y0).toBeLessThanOrEqual(top);
  });

  it("draws NO bands for a single repo — one band around everything states nothing", () => {
    expect(buildGraph([n("a", "o/one"), n("b", "o/one")], []).repoBands).toBeUndefined();
  });

  it("leaves a graph with no repos at all untouched — the L0 project network", () => {
    // L0's nodes are PROJECTS and carry no repo, so the project map cannot regress through this path.
    const nodes: GRawNode[] = [n("core"), n("api"), n("web")];
    const edges: GRawEdge[] = [{ from: "web", to: "api", kind: "api" }, { from: "api", to: "core", kind: "data" }];
    const m = buildGraph(nodes, edges);
    expect(m.repoBands).toBeUndefined();
    expect(m.nodes.map((x) => [x.id, x.x, x.y])).toEqual(buildGraph(nodes, edges).nodes.map((x) => [x.id, x.x, x.y]));
  });

  it("WRAPS a wide layer instead of stacking it, so the band's height is bounded", () => {
    // THE REASON THIS EXISTS. A fleet's layers are lopsided — base-studio-code's 30 streams fall into 5
    // layers of which ONE holds 16 — and a layer laid out as a single column makes the band as tall as
    // its widest layer, not as tall as its depth. 16 rows is ~1630px for one band alone.
    const many = Array.from({ length: 16 }, (_, i) => n(`w${i}`, "o/one"));
    const m = buildGraph([n("architect"), ...many, n("z", "o/two")], []);
    const band = m.repoBands!.find((b) => b.repo === "o/one")!;
    const rows = new Set(m.nodes.filter((x) => x.repo === "o/one").map((x) => x.y));
    expect(rows.size).toBeLessThanOrEqual(6);          // wrapped, not stacked 16 deep
    expect(band.y1 - band.y0).toBeLessThan(16 * NH);   // and the band is bounded by that
  });

  it("keeps LAYER ORDER left→right — the dependency meaning the packing must not lose", () => {
    // Re-packing is allowed to change WHERE in a column a node sits; it is not allowed to reorder the
    // layers, because that is the only thing the drill says about what depends on what.
    const raw = [n("a", "o/one"), n("b", "o/one"), n("c", "o/two")];
    const edges: GRawEdge[] = [{ from: "b", to: "a", kind: "api" }];
    const m = buildGraph(raw, edges);
    const at = (id: string) => m.nodes.find((v) => v.id === id)!;
    expect(at("a").layer).toBeLessThan(at("b").layer);
    expect(at("a").x).toBeLessThan(at("b").x);
  });

  it("gives each band a real zone the canvas can wash, out to the world's right edge", () => {
    const m = buildGraph([n("architect"), n("a", "o/one"), n("b", "o/two")], []);
    for (const b of m.repoBands!) {
      expect(b.y1).toBeGreaterThan(b.y0);
      expect(m.worldW).toBeGreaterThan(b.x0);   // a non-negative width for the rect
    }
  });

  it("CENTRES the band stack on the director, not the top of the graph", () => {
    // Built from the graph's top edge (the only reference available while packing), then centred — the
    // director's row is what a reader actually relates the workers to. Without this the workers hang
    // off the tier's top corner and the taller the fleet, the more lopsided it reads.
    const m = buildGraph([
      n("director"), n("a", "o/one"), n("b", "o/one"), n("c", "o/two"), n("d", "o/two"),
    ], []);
    const dir = m.nodes.find((x) => x.id === "director")!;
    const bands = m.repoBands!;
    const mid = (bands[0].y0 + bands[bands.length - 1].y1) / 2;
    expect(Math.abs(mid - (dir.y + NH / 2))).toBeLessThan(2);
  });

  it("never centres the stack off the top of the world", () => {
    // `worldH` is measured from the nodes, so a negative y is unreachable rather than merely ugly. A
    // fleet taller than its tier centres as far as it can and then sits at the top.
    const many = Array.from({ length: 14 }, (_, i) => n(`w${i}`, "o/one"));
    const m = buildGraph([n("director"), ...many, n("z", "o/two")], []);
    for (const b of m.repoBands!) expect(b.y0).toBeGreaterThanOrEqual(0);
    for (const node of m.nodes) expect(node.y).toBeGreaterThanOrEqual(0);
  });
});

describe("withStreamRepos — the join from the plan to the graph", () => {
  const data = (ids: string[]) => ({
    rawNodes: ids.map((id) => n(id)),
    rawEdges: [],
    sample: false,
  });
  const fleet = (streams: { id: string; repo: string }[]) => ({ streams }) as never;

  it("stamps a stream's repo onto the node of the same id", () => {
    const out = withStreamRepos(data(["console", "mobile-shell"]), fleet([
      { id: "console", repo: BASE }, { id: "mobile-shell", repo: MOBILE },
    ]));
    expect(out.rawNodes.map((x) => x.repo)).toEqual([BASE, MOBILE]);
  });

  it("leaves a node with no matching stream alone — the director is not a stream", () => {
    const out = withStreamRepos(data(["director", "console"]), fleet([{ id: "console", repo: BASE }]));
    expect(out.rawNodes.find((x) => x.id === "director")!.repo).toBeUndefined();
  });

  it("treats an EMPTY repo as absent rather than grouping under a nameless band", () => {
    // `parseFleetFile` keeps a stream whose repo could not be resolved VISIBLE with an empty `repo`
    // (#2611). Banding on "" would draw a group with no name, which reads as a bug rather than as the
    // missing datum it actually is — ungrouped is the honest position.
    const out = withStreamRepos(data(["orphan"]), fleet([{ id: "orphan", repo: "  " }]));
    expect(out.rawNodes[0].repo).toBeUndefined();
    expect(buildGraph(out.rawNodes, []).repoBands).toBeUndefined();
  });

  it("is a no-op for a fleet with no repos at all, preserving the graph's own fields", () => {
    const before = data(["a"]);
    expect(withStreamRepos(before, fleet([]))).toBe(before);
  });
});
