// THE CRATE DRILL'S CLICK HAS TO BE ROUTED (`a-crate-node-drills-into-its-verbs`).
//
// Inside a drill every node was sent to `expandNode`, which is right for a session and DEAD for a
// crate: it computed `fleetPaneId(drill, "surface:<crate>")`, a pane that cannot exist, so the click
// did nothing at all. A dead click reads as a broken app rather than an unimplemented feature — and no
// unit test of the graph builder can see it, because the builder is fine and simply never runs.
//
// A WIRING guard, like `glanceFoldsAreCalled`: it proves the route exists and where, not that the
// picture is right. `crateDrillGraph`'s own behaviour is pinned in `glanceSurfaceNodes.test.ts`.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src: string = JSON.parse(
  readFileSync("src-tauri/data/components/app/features/glance/glancepage.json", "utf8"),
).srcText;

describe("a crate node's click drills instead of trying to expand a session", () => {
  it("reads the workspace at all — an empty scan would pass every assertion below", () => {
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("const onNodeClick");
  });

  it("routes a crate to the second layer, BEFORE the expandNode fallback", () => {
    const drillAt = src.indexOf("else if (surfaceCrateOfNode(id)) setCrateNode(id);");
    const expandAt = src.indexOf("else expandNode(id);");
    expect(drillAt).toBeGreaterThan(-1);
    expect(expandAt).toBeGreaterThan(-1);
    // Order is the whole fix: `expandNode` is the catch-all, so a crate branch after it never runs.
    expect(drillAt).toBeLessThan(expandAt);
  });

  it("the second layer wins over the fleet graph when it is open", () => {
    expect(src).toContain("const model = crateModel ?? fleetModel ?? projectModel;");
    // …and everything downstream reads the same graph, or the sidebar and the canvas disagree.
    expect(src).toContain("const data = crateData ?? liveFleetData ?? projectData;");
  });

  it("steps out one layer at a time", () => {
    // Collapsing both levels into one hop throws away the layer just navigated into.
    expect(src).toContain("if (crateNode) {");
    expect(src).toContain("setCrateNode(null);");
  });

  it("clears the crate layer when the project drill goes, so it cannot strand", () => {
    expect(src).toContain("if (!drill && crateNode) setCrateNode(null);");
  });

  it("only real crate KINDS reach the legend — a verb's caption is its noun", () => {
    // At L2 the verb nodes are also `kind: "surface"` but captioned with their NOUN. Feeding those to
    // the crate-kind colour table yields `undefined`, i.e. a legend row with no colour.
    expect(src).toContain("k in CRATE_KIND_ROLE");
  });
});
