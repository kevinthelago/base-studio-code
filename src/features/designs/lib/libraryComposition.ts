// Component → library cross-graph composition (#3116 algorithms, #3117 sounds; epic #3114) — derive the
// `requires` edges a kit's components declare by importing `@bsc/<segment>/<name>` (an ALGORITHM via
// `@bsc/algorithms/…` OR a SOUND cue/voice via `@bsc/sounds/…`), plus the unique library nodes they
// reference, so the composition graph can render those nodes in a FENCED BAND (A's `layoutBand`) with dashed
// `requires` edges into them. Pure + React-free; DesignsWorkbench turns this into band positions + edge paths.
//
// Graph-agnostic: it delegates identity + resolution to `resolveLibrarySpec` (libraryModules.ts), which
// resolves EACH library graph against its default kit — so an algorithm ref and a sound-cue ref are
// collected UNIFORMLY here, each referenced node carrying the reusable `code` the preview vendors (an
// algorithm's real source, or a sound cue's generated player module). A component's URN is `ui:<kitId>/<id>`
// (the design graph); the referenced node's URN is the CANONICAL `algo:…`/`sound:…` the resolver mints.
// Edges are deduped by `crossGraphEdgeId`; a component with NO `@bsc/…` import contributes nothing (an empty
// result ⇒ the band is omitted entirely, byte-identical today).
import { crossGraphEdgeId, type CrossGraphEdge, type ResolvedNode } from "@/shared/lib/graph/crossGraph";
import { formatNodeUrn, isLibrarySpec, parseNodeUrn, type NodeGraph } from "@/shared/lib/graph/nodeUrn";
import { resolveLibrarySpec } from "./libraryModules";
import type { ComponentRecord } from "./model";

/** The design graph a component node lives in (its URN's leading token). */
const DESIGN_GRAPH = "ui" as const;

/** Every module specifier imported/exported-from in `source`, deduped — a loose regex scan (over-inclusion
 *  is harmless; the caller only acts on the `@bsc/…` ones). A local twin of the scanners in
 *  componentPreview / graphHealth (kept local so this module doesn't depend on either). */
function importSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  let m: RegExpExecArray | null;
  const fromRe = /\bfrom\s*["']([^"']+)["']/g;
  const importRe = /\bimport\s*\(?\s*["']([^"']+)["']/g;
  while ((m = fromRe.exec(source))) specs.add(m[1]);
  while ((m = importRe.exec(source))) specs.add(m[1]);
  return [...specs];
}

/** A component's scannable source — its explicit `source`, else its `srcText`. We scan whichever the record
 *  carries: even a usage-snippet `srcText` that imports `@bsc/…` honestly declares the dependency the graph
 *  should show (unlike the buildability checks, this is a VISUAL affordance, not a build gate). */
function componentSource(c: ComponentRecord): string {
  return (c.source?.trim() ? c.source : c.srcText) ?? "";
}

/** The derived cross-graph composition for a kit's components — its library `requires` edges + nodes. */
export interface LibraryComposition {
  /** The `requires` edges (a component URN → a library-node URN), deduped, in first-seen order. */
  edges: CrossGraphEdge[];
  /** The UNIQUE referenced library nodes (an algorithm's / sound's resolved node, carrying its `code`), in
   *  first-seen order — one band card each. */
  nodes: ResolvedNode[];
}

/**
 * Derive the `requires` edges + referenced library nodes for `comps` from their `@bsc/<segment>/<name>`
 * imports (algorithms AND sounds). Only references that RESOLVE to a runnable node (one carrying `code`) are
 * included — an unresolvable `@bsc/…/<missing>` (or a code-less primitive descriptor) is a graphHealth
 * finding, not a graph node. Deterministic. Pure.
 */
export function resolveComponentLibraryRefs(comps: readonly ComponentRecord[]): LibraryComposition {
  const edges: CrossGraphEdge[] = [];
  const nodesByUrn = new Map<string, ResolvedNode>();
  const seenEdge = new Set<string>();
  for (const c of comps) {
    const src = componentSource(c);
    if (!src) continue;
    const fromUrn = formatNodeUrn(DESIGN_GRAPH, c.kitId, c.id);
    if (!fromUrn) continue;
    for (const spec of importSpecifiers(src)) {
      if (!isLibrarySpec(spec)) continue;
      const node = resolveLibrarySpec(spec);
      if (!node || !node.code) continue; // resolvable + runnable (has code) only
      nodesByUrn.set(node.urn, node);
      const id = crossGraphEdgeId(fromUrn, node.urn);
      if (seenEdge.has(id)) continue;
      seenEdge.add(id);
      edges.push({ id, fromUrn, toUrn: node.urn, rel: "requires" });
    }
  }
  return { edges, nodes: [...nodesByUrn.values()] };
}

/** One (kit → library node) dependency, rolled up from the component level (#3133) — "some component of
 *  `kitId` requires this library node". The APP-LEVEL projection of {@link resolveComponentLibraryRefs}:
 *  Glance joins it against the kit-consumer index (`kitUsage`) to draw a PROJECT's `requires` edges, so it
 *  carries only what a band node needs (identity + label), never a component or a blob of `code`. */
export interface KitLibraryRef {
  /** The consuming kit — the join key against `kitUsage`'s `kitId`. */
  kitId: string;
  /** The library graph the required node lives in. Never `"ui"` (see {@link resolveKitLibraryRefs}). */
  graph: NodeGraph;
  /** The required node's canonical in-graph id (`fibonacci.ts`, `click`) — the band node's library id. */
  id: string;
  /** The node's display name (`fibonacci`) — the band card's label. */
  label: string;
}

/**
 * Roll a component library composition UP to the KIT level (#3133) — every (kit, library node) pair the
 * components declare, deduped, in first-seen order. This is the app-graph's data source: a project consumes
 * kits (`kitUsage`), a kit's components require library nodes, so a project transitively requires them.
 *
 * Derived from {@link resolveComponentLibraryRefs} (one scan, no second regex pass): each `requires` edge's
 * `fromUrn` is `ui:<kitId>/<componentId>`, so the kit falls straight out of the URN.
 *
 * `ui`-graph targets are EXCLUDED: a `ui` library node id would be `kit:<id>`, colliding with the Glance
 * node id of an actual UI kit. Today `resolveLibrarySpec` never resolves the `ui` graph, so this is a fence
 * against a future `@bsc/ui/…` vendor path silently corrupting the app graph, not live filtering.
 *
 * Cost is one pass over the derived edges — the expensive part is the source scan inside
 * `resolveComponentLibraryRefs`, so callers should memoize on the component list. Pure + deterministic.
 */
export function resolveKitLibraryRefs(comps: readonly ComponentRecord[]): KitLibraryRef[] {
  const { edges, nodes } = resolveComponentLibraryRefs(comps);
  const nodeByUrn = new Map(nodes.map((n) => [n.urn, n]));
  const out: KitLibraryRef[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const from = parseNodeUrn(e.fromUrn);
    const node = nodeByUrn.get(e.toUrn);
    if (!from || !node || node.graph === "ui") continue;
    const key = `${from.kit}\u0000${node.urn}`; // one ref per (kit, node) — N components of a kit ⇒ 1 ref
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kitId: from.kit, graph: node.graph, id: node.id, label: node.label });
  }
  return out;
}
