// Cross-graph LIBRARY band (#3119, epic #3114) — the generalized fenced band now renders ALGORITHM +
// SOUND library nodes (via `requires` edges) alongside the UI-kit `uses-kit` dimension. The canvas
// renders each library flavour distinctly, the band header names the dimension(s) present, the legend
// describes the new edge/node dimensions, and the inspector opens a library-scoped panel.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GlanceCanvas, GlanceOverlays } from "./GlanceCanvas";
import { GlanceInspector } from "./GlanceInspector";
import { buildGraph, libraryNodeId, requiresEdgeId, type GRawNode, type GRawEdge } from "./lib/glanceGraph";
// #3133 — the REAL data path: the designs roll-up + the Glance adapter, joined end to end below.
import { buildGlanceData } from "./lib/glanceData";
import { resolveKitLibraryRefs, type ComponentRecord } from "@/features/designs";

const ALGO = libraryNodeId("algo", "dijkstra");
const SOUND = libraryNodeId("sound", "chime");

// A route-planner app requiring one algorithm + one sound cue — the logistics example from the epic.
const rawNodes: GRawNode[] = [
  { id: "route-planner", slug: "Route Planner", role: "service", category: "greenfield", health: "off", activity: "idle" },
  { id: ALGO, slug: "Dijkstra", kind: "library", library: "algo", role: "infra", health: "off", activity: "idle" },
  { id: SOUND, slug: "Chime", kind: "library", library: "sound", role: "infra", health: "off", activity: "idle" },
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
        { id: "app", role: "service", health: "off", activity: "idle" },
        { id: ALGO, slug: "Dijkstra", kind: "library", library: "algo", role: "infra", health: "off", activity: "idle" },
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

// #3133 — the END-TO-END path the band exists for: a REAL component record whose source imports
// `@bsc/algorithms/fibonacci` → the designs roll-up resolves it against the packaged algorithm seed →
// `buildGlanceData` joins it against kit usage → the canvas renders the band. No hand-written `requires`
// fixture anywhere in this describe: every node/edge below is derived from the component's source text.
describe("Glance band from REAL library refs (#3133)", () => {
  const comp: ComponentRecord = {
    id: "RouteCard", name: "RouteCard", kitId: "react-ui", role: "composite", version: "1", used: 1,
    tags: [], variants: ["default"], composes: [], props: [], whenUse: [], whenNot: [], src: "", srcText: "",
    source: 'import { fibonacci } from "@bsc/algorithms/fibonacci";\nexport const RouteCard = () => fibonacci(10);',
  };
  const realModel = () => {
    const refs = resolveKitLibraryRefs([comp]);
    const data = buildGlanceData(
      [{ id: "route-planner", name: "Route Planner" }], [],
      [{ projectKey: "route-planner", kitId: "react-ui" }], [{ id: "react-ui", name: "React UI" }], refs,
    );
    return buildGraph(data.rawNodes, data.rawEdges);
  };

  it("renders the required ALGORITHM in the fenced band, edged from the consuming project", () => {
    const model = realModel();
    render(canvas(model));
    expect(screen.getByText("fibonacci")).toBeTruthy();   // the real seed algorithm's label
    expect(screen.getByText("algorithm")).toBeTruthy();    // its library kind word
    expect(screen.getByText("React UI")).toBeTruthy();     // the kit dimension still renders alongside
    expect(screen.getByText("Route Planner")).toBeTruthy();
    // the band is FENCED — the library nodes sit in their own zone above the project network (#3007).
    expect(model.kitBand).toBeTruthy();
    const algo = model.nodes.find((n) => n.id === libraryNodeId("algo", "fibonacci.ts"));
    const proj = model.nodes.find((n) => n.id === "route-planner");
    expect(algo && proj && algo.y < proj.y).toBe(true);
  });

  it("opens the ALGORITHM inspector panel for the real node, naming its consuming project", () => {
    const model = realModel();
    render(
      <GlanceInspector model={model} selType="node" selId={libraryNodeId("algo", "fibonacci.ts")}
        onSelectNode={noop} onClose={noop} />,
    );
    expect(screen.getByText("ALGORITHM")).toBeTruthy();
    expect(screen.getByText("fibonacci")).toBeTruthy();
    expect(screen.getByText("Route Planner")).toBeTruthy();
  });
});
