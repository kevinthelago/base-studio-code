// THE PROJECT DRILL IS ONE LAYER (`the-project-drill-is-one-layer-and-every-node-opens-its-session`).
//
// The drill had a crate sub-layer and a feature sub-layer, gated on a local/claude session mode. In local
// mode a click on a noun or a feature opened a second graph instead of a session, so the voice project's
// nodes never started one and core's `data` kept drilling down. The maintainer retired both layers and the
// mode: streams are the nodes, and clicking any node in a drill opens its session.
//
// A WIRING guard over the Glance page's source, like `glanceFoldsAreCalled`: it proves the sub-layer
// machinery is gone and the click reaches `expandNode`, not that the picture is right.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src: string = JSON.parse(
  readFileSync("src-tauri/data/components/app/features/glance/glancepage.json", "utf8"),
).srcText;

/** The body of `onNodeClick`, up to the next top-level `const` — the handler a click actually runs. */
function clickHandler(): string {
  const at = src.indexOf("const onNodeClick = (id: string) => {");
  expect(at, "onNodeClick is still defined").toBeGreaterThan(-1);
  const end = src.indexOf("\n  const ", at + 10);
  return src.slice(at, end < 0 ? undefined : end);
}

describe("the project drill is one layer", () => {
  it("reads the workspace at all — an empty scan would pass every assertion below", () => {
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("const onNodeClick");
  });

  it("holds no crate or feature sub-layer state", () => {
    for (const gone of ["crateNode", "featureNode", "setCrateNode", "setFeatureNode", "crateModel", "featureModel", "liveCrateDrill", "featureDrill"]) {
      expect(src, `${gone} belongs to a removed sub-layer`).not.toContain(gone);
    }
  });

  it("asks no session mode how many layers there are", () => {
    expect(src).not.toContain("sessionMode");
    expect(src).not.toContain("opensSubLayer");
    expect(src).not.toContain('"session", "mode"');
  });

  it("folds no feature or crate grouping node over the streams", () => {
    expect(src).not.toContain("withFeatureNodes(");
    expect(src).not.toContain("withSurfaceNodes(");
  });

  it("draws the drill from the fleet graph alone", () => {
    expect(src).toContain("const model = fleetModel ?? projectModel;");
    expect(src).toContain("const data = liveFleetData ?? projectData;");
  });

  it("sends every non-preview click in a drill to expandNode", () => {
    const body = clickHandler();
    const drillBranch = body.slice(body.indexOf("if (drill) {"), body.indexOf("\n    }", body.indexOf("if (drill) {")));
    expect(drillBranch).toContain("PREVIEW_NODE_ID");
    expect(drillBranch).toContain("else expandNode(id);");
    // No other routing may sit between the preview and the session: that is where the sub-layers were.
    expect(drillBranch.match(/else if/g) ?? []).toHaveLength(0);
  });

  it("declares nothing in a drill as drillable", () => {
    expect(src).toContain("drillable: drill ? false :");
  });
});
