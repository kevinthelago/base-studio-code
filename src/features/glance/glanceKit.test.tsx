// UI-kit node (#2571) — the kit node reads distinctly on the canvas (◆ · "kit" · consumer count) and the
// inspector shows the kit id + the projects that consume it.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GlanceCanvas, GlanceOverlays } from "./GlanceCanvas";
import { GlanceInspector } from "./GlanceInspector";
import { buildGlanceData } from "./lib/glanceData";
import { buildGraph, kitNodeId } from "./lib/glanceGraph";

const projects = [{ id: "app-a", name: "App A" }, { id: "app-b", name: "App B" }];
const kits = [{ id: "react-ui", name: "React UI" }];
const usage = [{ projectKey: "app-a", kitId: "react-ui" }, { projectKey: "app-b", kitId: "react-ui" }];
const data = buildGlanceData(projects, [], usage, kits);
const model = buildGraph(data.rawNodes, data.rawEdges);

const noop = () => {};
const dragMoved = { current: false };

describe("GlanceCanvas — UI-kit node (#2571)", () => {
  it("renders the kit node distinctly — its name, a 'kit' marker, and the consumer count", () => {
    render(
      <GlanceCanvas model={model} dragMoved={dragMoved} focus={null} selNodeId={null} selEdgeId={null}
        onHoverNode={noop} onHoverEdge={noop} onSelectNode={noop} onSelectEdge={noop} />,
    );
    expect(screen.getByText("React UI")).toBeTruthy(); // the kit's display name
    expect(screen.getByText("kit")).toBeTruthy();      // the "kit" label distinguishes it from a project
    expect(screen.getByText("2 apps")).toBeTruthy();   // both projects consume it
  });
});

describe("GlanceOverlays legend — UI-kit edge (#2571)", () => {
  it("adds a 'uses kit' row to the L0 project-network edge legend", () => {
    render(<GlanceOverlays />);
    expect(screen.getByText("uses kit")).toBeTruthy();
  });
});

describe("GlanceInspector — UI-kit node (#2571)", () => {
  it("shows the kit id + the projects that consume it", () => {
    render(<GlanceInspector model={model} selType="node" selId={kitNodeId("react-ui")} onSelectNode={noop} onClose={noop} />);
    expect(screen.getByText("UI KIT")).toBeTruthy();       // the panel header
    expect(screen.getByText("react-ui")).toBeTruthy();     // the kit id
    expect(screen.getByText("2 projects")).toBeTruthy();   // consumer count
    expect(screen.getByText("CONSUMED BY")).toBeTruthy();
    expect(screen.getByText("App A")).toBeTruthy();        // each consuming project, clickable
    expect(screen.getByText("App B")).toBeTruthy();
  });
});
