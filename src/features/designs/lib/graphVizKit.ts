// The `graph-viz` builtin kit assembly (#3242, epic #3220/#2942) — registers the graph-visualization
// motion library (frontier / visit / relax) as a RECOVERABLE builtin kit in the Designs store, so the set
// is VISIBLE + EDITABLE in the Design Studio's AnimationsMenu and self-heals if deleted. The graph twin of
// `algoVizKit` (#3194) — see that module for the full why (separate seam from `makeBuiltinKits`, and how
// recover/shadow-proof works via the #2483 reconcile).
import { GRAPH_VIZ_KIT_ID, GRAPH_VIZ_ANIMATIONS } from "@/shared/ui/kit/graphVizAnimations";
import type { ComponentRecord, Kit } from "./model";
import { stampSeedHash } from "./seedRefresh";

/** The demo component's id — a self-contained SVG node-link diagram that previews the graph base motions. */
export const GRAPH_NODES_ID = "graphnodes";

/**
 * A SELF-CONTAINED demo module (#3242) — the `srcText` the Design-Studio preview builds. No `@/` imports
 * and JSX via the automatic runtime. It renders a tiny SVG node-link diagram whose elements carry the
 * data-state the kit's animations key on (`data-op="frontier|visit|relax"`); the preview frame stamps the
 * `.graph-viz-anim-*` applying classes on `#root`, so on mount it visibly plays frontier / visit / relax.
 * The animated nodes carry `transformBox: fill-box` + `transformOrigin: center` so the visit scale stays
 * centred (SVG transforms default to the viewport origin) — the same fix graphView.css applies.
 */
const GRAPH_NODES_SRC = `// GraphNodes (#3242) — a self-contained demo of the graph-viz base motions. Each SVG element carries the
// data-state the kit's animations key on, so the Design-Studio preview plays frontier / visit / relax on
// mount. No imports: JSX uses the automatic runtime; the .graph-viz-anim-* applying classes are stamped on
// #root by the preview frame. SVG transforms are centred via transform-box: fill-box.
const NODE = { transformBox: "fill-box", transformOrigin: "center", fill: "var(--bg-elev, #1b1b1f)", stroke: "var(--border, #444)", strokeWidth: 1.5 };

export function GraphNodes() {
  return (
    <svg viewBox="0 0 220 110" style={{ width: 220, height: 110, padding: 12 }}>
      <line data-op="relax" x1="40" y1="55" x2="110" y2="30" stroke="var(--border, #444)" strokeWidth="1.5" />
      <line x1="110" y1="30" x2="180" y2="55" stroke="var(--border, #444)" strokeWidth="1.5" />
      <line x1="40" y1="55" x2="110" y2="82" stroke="var(--border, #444)" strokeWidth="1.5" />
      <circle data-op="visit" cx="40" cy="55" r="15" style={NODE} />
      <circle data-op="frontier" cx="110" cy="30" r="15" style={NODE} />
      <circle data-op="frontier" cx="110" cy="82" r="15" style={NODE} />
      <circle cx="180" cy="55" r="15" style={NODE} />
    </svg>
  );
}
`;

/**
 * Assemble the `graph-viz` builtin kit + its demo component, `builtin`- and `seedHash`-stamped exactly like
 * the packaged kits. The kit's `animations` is the SHARED {@link GRAPH_VIZ_ANIMATIONS} (one definition,
 * reused by the GraphView renderer too); the demo binds all three by NAME so they surface as its motion
 * presets AND the kit's shelf in the AnimationsMenu. Every projection-defaulted field is set explicitly at
 * its default so the record survives the push→store→load round-trip byte-for-byte (the #2514 contract).
 */
export function makeGraphVizKit(): { kits: Kit[]; components: ComponentRecord[] } {
  const kit: Kit = {
    id: GRAPH_VIZ_KIT_ID,
    name: "Graph Viz",
    tech: "react",
    style: "data-viz",
    stack: "React · Data viz",
    dot: "var(--violet)",
    animations: GRAPH_VIZ_ANIMATIONS,
    builtin: true,
  };

  const demo: ComponentRecord = {
    id: GRAPH_NODES_ID,
    name: "GraphNodes",
    kitId: GRAPH_VIZ_KIT_ID,
    role: "primitive",
    group: "data-viz",
    version: "1.0.0",
    used: 0,
    tags: ["graph", "motion", "traversal"],
    variants: ["default"],
    composes: [],
    props: [],
    whenUse: ["Preview the graph-viz base motions (frontier / visit / relax) on an SVG node-link diagram."],
    whenNot: ["Rendering a real graph traversal — use GraphView (a later step)."],
    src: "graph-viz/GraphNodes.tsx",
    srcText: GRAPH_NODES_SRC,
    animations: GRAPH_VIZ_ANIMATIONS.map((a) => a.name),
    builtin: true,
  };

  return { kits: [stampSeedHash(kit)], components: [stampSeedHash(demo)] };
}
