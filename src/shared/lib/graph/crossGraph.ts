// Cross-graph resolution + the `requires` edge (#3115, epic #3114). Builds on the URN grammar in
// ./nodeUrn: a URN NAMES a node; this module RESOLVES it to a normalized record, models the cross-graph
// `requires` edge, and lays foreign nodes out in a fenced band (the shape generalized from Glance's UI-kit
// band, #3007). All pure + feature-agnostic — a feature adapts its own hydrated store into a `NodeLookup`
// (it never imports another feature's types), and the consumer composes the per-graph lookups into one
// resolver via {@link makeUrnResolver}.
import { parseNodeUrn, type NodeGraph } from "./nodeUrn";

/** A node resolved across graphs — the normalized shape every pillar maps its own record onto, so a
 *  consumer (the component preview, the app graph) can treat an algorithm, a component, and a sound cue
 *  uniformly. Deliberately minimal: identity + label + kind, plus the reusable implementation when the
 *  graph carries one (an algorithm's `code`), which is what the preview vendors (#3116). */
export interface ResolvedNode {
  /** The canonical `<graph>:<kit>/<id>` URN this node resolved from. */
  urn: string;
  graph: NodeGraph;
  kit: string;
  id: string;
  /** Human label for the node card (the node's display name). */
  label: string;
  /** The graph-specific kind slug — `algorithm`/`primitive`, a component `role`, or `cue`/`voice`/
   *  `primitive`. Opaque here; the consumer/legend interprets it per graph. */
  kind: string;
  /** The reusable implementation source when the graph has one (an algorithm's `code`). Absent for a
   *  descriptor-only node (a sounds primitive, a spec component). The preview vendors this (#3116). */
  code?: string;
}

/** A single graph's lookup: given a kit + in-kit id, return the resolved node or null. A feature builds
 *  this from its hydrated store data (e.g. algorithms: find the impl with `tech === kit && id === id`). */
export type NodeLookup = (kit: string, id: string) => ResolvedNode | null;

/** Resolve any node URN to its {@link ResolvedNode}, or null (unknown graph, or the target doesn't exist). */
export type UrnResolver = (urn: string) => ResolvedNode | null;

/**
 * Compose per-graph {@link NodeLookup}s into one {@link UrnResolver}. A missing graph in the registry (or
 * a lookup miss) resolves to null — so a resolver wired with only `{ algo }` cleanly returns null for a
 * `sound:` URN instead of throwing. The returned node's `urn`/`graph`/`kit`/`id` are always overwritten
 * from the URN, so a lookup can't mislabel identity (it only supplies `label`/`kind`/`code`).
 */
export function makeUrnResolver(registry: Partial<Record<NodeGraph, NodeLookup>>): UrnResolver {
  return (urn: string): ResolvedNode | null => {
    const parts = parseNodeUrn(urn);
    if (!parts) return null;
    const lookup = registry[parts.graph];
    if (!lookup) return null;
    const found = lookup(parts.kit, parts.id);
    if (!found) return null;
    return { ...found, urn, graph: parts.graph, kit: parts.kit, id: parts.id };
  };
}

/** The only cross-graph relationship today — a node `requires` a node in another graph (a UI component
 *  requires an algorithm). Kept distinct from an in-kit `composes` so "built from my siblings" never
 *  blurs with "pulls in a foreign capability". */
export type CrossGraphRel = "requires";

/** A directed edge between two graphs: the node at `fromUrn` requires the node at `toUrn`. */
export interface CrossGraphEdge {
  id: string;
  fromUrn: string;
  toUrn: string;
  rel: CrossGraphRel;
}

/** Stable, collision-proof id for a cross-graph edge (`<fromUrn>~requires~<toUrn>`). */
export function crossGraphEdgeId(fromUrn: string, toUrn: string, rel: CrossGraphRel = "requires"): string {
  return `${fromUrn}~${rel}~${toUrn}`;
}

// ── The fenced band (#3007, generalized) — foreign/library nodes lifted OUT of a graph's main layout into
// a single row across the top, reading as a separate dimension. Glance does exactly this for UI-kit nodes;
// this is that math, parameterized, so the component graph (#3116/#3117) and the app graph (#3119) all
// render their pulled-in library nodes the same way. Pure + deterministic. ──

/** Inputs for {@link layoutBand} — all in world (design) coordinates. */
export interface BandOpts {
  /** Left edge of the content span the band centers over (Glance uses its layout's 70px left pad). */
  spanX0: number;
  /** Right edge of the content span (Glance uses the max project-node x). */
  spanX1: number;
  /** y of the band cards' TOP edge. */
  topPad: number;
  /** Band card height (so the divider clears the cards). */
  nodeH: number;
  /** Clearance from the cards' bottom down to the fence divider. */
  gap: number;
  /** Cap on the horizontal step between cards, so a couple of nodes cluster in the middle instead of
   *  stretching the full width (Glance caps at one column gap). */
  maxStep: number;
}

/** A laid-out band: each node's top-left position, plus the band's vertical extent + fence divider y. */
export interface BandLayout {
  positions: { x: number; y: number }[];
  /** Top of the band zone. */
  y0: number;
  /** Bottom of the band zone (== `dividerY`) — the rest of the graph shifts down by this much. */
  y1: number;
  /** y of the fence divider drawn under the band. */
  dividerY: number;
}

/**
 * Lay `count` foreign nodes out in a single centered row across the top, and report the fence divider the
 * main graph shifts below. Mirrors Glance's kit-band math (#3007): evenly spaced over [spanX0, spanX1] but
 * the step never exceeds `maxStep`. `count === 0` → no positions (the caller omits the band entirely).
 * Deterministic.
 */
export function layoutBand(count: number, opts: BandOpts): BandLayout {
  const { spanX0, spanX1, topPad, nodeH, gap, maxStep } = opts;
  const dividerY = topPad + nodeH + gap;
  const positions: { x: number; y: number }[] = [];
  if (count > 0) {
    const span = Math.max(0, spanX1 - spanX0);
    const step = count > 1 ? Math.min(span / (count - 1), maxStep) : 0;
    const rowW = step * (count - 1);
    const startX = spanX0 + (span - rowW) / 2;
    for (let i = 0; i < count; i++) positions.push({ x: startX + i * step, y: topPad });
  }
  return { positions, y0: 0, y1: dividerY, dividerY };
}
