// Cross-graph LIBRARY band (#3119, epic #3114) — the generalized fenced band now renders ALGORITHM +
// SOUND library nodes (via `requires` edges) alongside the UI-kit `uses-kit` dimension. The canvas
// renders each library flavour distinctly, the band header names the dimension(s) present, the legend
// describes the new edge/node dimensions, and the inspector opens a library-scoped panel.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GlanceCanvas, GlanceOverlays } from "./GlanceCanvas";
import { GlanceInspector } from "./GlanceInspector";
import { buildGraph, libraryNodeId, requiresEdgeId, type GRawNode, type GRawEdge } from "./lib/glanceGraph";

const ALGO = libraryNodeId("algo", "dijkstra");
const SOUND = libraryNodeId("sound", "chime");

// A route-planner app requiring one algorithm + one sound cue — the logistics example from the epic.
const rawNodes: GRawNode[] = [
  { id: "route-planner", slug: "Route Planner", role: "service", category: "greenfield", health: "idle", activity: "idle" },
  { id: ALGO, slug: "Dijkstra", kind: "library", library: "algo", role: "infra", health: "idle", activity: "idle" },
  { id: SOUND, slug: "Chime", kind: "library", library: "sound", role: "infra", health: "idle", activity: "idle" },
];
const rawEdges: GRawEdge[] = [
  { id: requiresEdgeId("route-planner", ALGO), from: "route-planner", to: ALGO, kind: "requires" },
  { id: requiresEdgeId("route-planner", SOUND), from: "route-planner", to: SOUND, kind: "requires" },
];
const model = buildGraph(rawNodes, rawEdges);

const noop = () => {};
const dragMoved = { current: false };
const canvas = (m = model) => (
  <GlanceCanvas model={m} dragMoved={dragMoved} focus={null} selNodeId={null} selEdgeId={null}
    onHoverNode={noop} onHoverEdge={noop} onSelectNode={noop} onSelectEdge={noop} />
);

describe("GlanceCanvas — cross-graph library nodes (#3119)", () => {
  it("renders an algorithm + a sound library node distinctly, with their kind word + consumer count", () => {
    render(canvas());
    expect(screen.getByText("Dijkstra")).toBeTruthy();   // the algorithm node's name
    expect(screen.getByText("Chime")).toBeTruthy();       // the sound node's name
    expect(screen.getByText("algorithm")).toBeTruthy();   // the kind word distinguishes it from a kit/project
    expect(screen.getByText("sound")).toBeTruthy();
    expect(screen.getAllByText("1 app")).toHaveLength(2); // one consumer (route-planner) each
  });

  it("labels a MIXED band 'LIBRARIES' and a single-dimension band by that graph's name", () => {
    render(canvas());
    expect(screen.getByText("LIBRARIES")).toBeTruthy();   // algo + sound present ⇒ neutral header

    const algoOnly = buildGraph(
      [
        { id: "app", role: "service", health: "idle", activity: "idle" },
        { id: ALGO, slug: "Dijkstra", kind: "library", library: "algo", role: "infra", health: "idle", activity: "idle" },
      ],
      [{ id: requiresEdgeId("app", ALGO), from: "app", to: ALGO, kind: "requires" }],
    );
    render(canvas(algoOnly));
    expect(screen.getByText("ALGORITHMS")).toBeTruthy();  // only algorithms ⇒ the algo header
  });
});

describe("GlanceOverlays legend — library dimensions (#3119)", () => {
  it("L0: adds a 'requires' edge row + a LIBRARY node-dimension column, without regressing 'uses kit'", () => {
    render(<GlanceOverlays />);
    expect(screen.getByText("uses kit")).toBeTruthy();    // #2571 kit edge — not regressed
    expect(screen.getByText("requires")).toBeTruthy();    // #3119 generalized cross-graph edge
    expect(screen.getByText("LIBRARY")).toBeTruthy();     // the new node-dimension column header
    expect(screen.getByText("algorithm")).toBeTruthy();   // its rows: kit / algorithm / sound
    expect(screen.getByText("sound")).toBeTruthy();
  });

  it("L1 (drill): the L0-only LIBRARY column + requires row are hidden", () => {
    render(<GlanceOverlays drill archetypes={[]} />);
    expect(screen.queryByText("LIBRARY")).toBeNull();
    expect(screen.queryByText("requires")).toBeNull();
  });
});

describe("GlanceInspector — library node (#3119)", () => {
  it("opens an ALGORITHM-scoped panel: the id, its consumer, and the 'requires' relationship", () => {
    render(<GlanceInspector model={model} selType="node" selId={ALGO} onSelectNode={noop} onClose={noop} />);
    expect(screen.getByText("ALGORITHM")).toBeTruthy();      // the panel header (vs the UI-KIT panel)
    expect(screen.getByText("Dijkstra")).toBeTruthy();        // the node name
    expect(screen.getByText("dijkstra")).toBeTruthy();        // the in-graph library id (prefix stripped)
    expect(screen.getByText("1 project")).toBeTruthy();       // consumer count
    expect(screen.getByText("CONSUMED BY")).toBeTruthy();
    expect(screen.getByText("Route Planner")).toBeTruthy();   // the consuming project, clickable
    expect(screen.getByText("requires")).toBeTruthy();        // the consumer DepRow's relationship word
  });
});
