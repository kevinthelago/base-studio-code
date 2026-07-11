// forceLayout (#2820) — the pure, headless `d3-force` layout behind the `ForceGraph` component. Kept
// React-free (a `.ts`, mirroring `features/teams/lib/orgLayout`) so it's unit-testable and the component
// stays a thin SVG renderer.
//
// Determinism: seed positions are computed (a ring, no `Math.random`), the simulation is `.stop()`-ed
// and ticked a fixed number of times (d3-force's internal jiggle is a seeded LCG, and coincidence-jiggle
// never fires because the seeds are distinct), then the settled cloud is fit into the frame. No animation
// loop → it renders identically every time and is testable in jsdom.
import {
  forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide,
  type SimulationNodeDatum,
} from "d3-force";

/** A graph node. `group` cycles the categorical node color; `label` renders under the node. */
export interface ForceGraphNode {
  id: string;
  label?: string;
  group?: number;
}

/** An edge between two node ids (undirected — drawn as a plain line). */
export interface ForceGraphLink {
  source: string;
  target: string;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  group: number;
}

const NODE_R = 6;
const PAD = 24;      // inner frame padding so nodes + labels never clip
const LINK_DIST = 46;
const CHARGE = -220;
const TICKS = 300;   // headless ticks to convergence (deterministic — see the module note)

/** A node placed in screen space after the layout runs. */
export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  group: number;
  label?: string;
}
/** A link resolved to its two endpoints' screen coordinates. */
export interface PlacedLink {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface ForceGraphLayout {
  nodes: PlacedNode[];
  links: PlacedLink[];
}

/**
 * Run a headless, deterministic `d3-force` layout and fit it into a `width`×`height` box.
 *
 * Pure (no React, no DOM) — mirroring `orgLayout.autoLayout`. Returns screen-space node positions +
 * resolved link endpoints. Links referencing an unknown node id are dropped.
 */
export function forceLayout(
  rawNodes: ForceGraphNode[],
  rawLinks: ForceGraphLink[],
  width = 320,
  height = 220,
): ForceGraphLayout {
  const n = Math.max(1, rawNodes.length);
  // Deterministic seed positions on a ring (no Math.random) — distinct per node, so d3-force's
  // coincidence-jiggle (its only Math.random path) never fires and the layout is reproducible.
  const nodes: SimNode[] = rawNodes.map((nd, i) => ({
    id: nd.id,
    group: nd.group ?? 0,
    x: Math.cos((2 * Math.PI * i) / n) * 60,
    y: Math.sin((2 * Math.PI * i) / n) * 60,
  }));
  const byId = new Map(nodes.map((nd) => [nd.id, nd]));
  const labels = new Map(rawNodes.map((nd) => [nd.id, nd.label]));
  const validLinks = rawLinks.filter((l) => byId.has(l.source) && byId.has(l.target));
  // d3-force's forceLink MUTATES its links array IN PLACE — after the sim runs, each link's source/target
  // is the resolved node OBJECT, not the original string id. Hand it a SEPARATE copy so `validLinks` keeps
  // its string ids for resolving the output endpoints below (else `pos.get(link.source)` is handed a node
  // object, misses the string-keyed map, and returns undefined → a crash reading `.x`).
  const simLinks = validLinks.map((l) => ({ source: l.source, target: l.target }));

  const sim = forceSimulation<SimNode>(nodes)
    .force("link", forceLink<SimNode, { source: string; target: string }>(simLinks).id((d) => d.id).distance(LINK_DIST).strength(0.5))
    .force("charge", forceManyBody<SimNode>().strength(CHARGE))
    .force("center", forceCenter<SimNode>(0, 0))
    .force("collide", forceCollide<SimNode>(NODE_R + 4))
    .stop();
  for (let i = 0; i < TICKS; i++) sim.tick();

  // Fit the settled cloud into the padded frame (uniform scale + center) — robust for any node count.
  const xs = nodes.map((nd) => nd.x ?? 0);
  const ys = nodes.map((nd) => nd.y ?? 0);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min((width - 2 * PAD) / spanX, (height - 2 * PAD) / spanY);
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  const fit = (x: number, y: number) => ({ x: (x - minX) * scale + offX, y: (y - minY) * scale + offY });

  const placed: PlacedNode[] = nodes.map((nd) => {
    const p = fit(nd.x ?? 0, nd.y ?? 0);
    return { id: nd.id, x: p.x, y: p.y, group: nd.group, label: labels.get(nd.id) };
  });
  const pos = new Map(placed.map((p) => [p.id, p]));
  const outLinks: PlacedLink[] = validLinks.map((l) => {
    const a = pos.get(l.source)!;
    const b = pos.get(l.target)!;
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  });
  return { nodes: placed, links: outLinks };
}

/** Categorical node colors (design tokens), cycled by a node's `group`. */
export const FORCE_GROUP_COLORS = [
  "var(--accent)", "var(--success)", "var(--info)", "var(--state-wait)", "var(--danger)", "var(--violet)",
];

/** Node circle radius (px) — shared by the layout's collision pad and the renderer. */
export const FORCE_NODE_R = NODE_R;
