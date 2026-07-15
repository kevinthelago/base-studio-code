// Component → Algorithm cross-graph composition (#3116, epic #3114) — derive the `requires` edges a kit's
// components declare by importing `@bsc/<segment>/<name>`, plus the unique library nodes they reference, so
// the composition graph can render those nodes in a FENCED BAND (A's `layoutBand`) with dashed `requires`
// edges into them. Pure + React-free; DesignsWorkbench turns this into band positions + edge paths.
//
// A component's URN is `ui:<kitId>/<id>` (the design graph); the referenced node's URN is the CANONICAL
// `algo:<tech>/<id>` the resolver mints. Edges are deduped by `crossGraphEdgeId`; a component with NO
// `@bsc/…` import contributes nothing (an empty result ⇒ the band is omitted entirely, byte-identical today).
import { crossGraphEdgeId, type CrossGraphEdge, type ResolvedNode } from "@/shared/lib/graph/crossGraph";
import { formatNodeUrn, isLibrarySpec } from "@/shared/lib/graph/nodeUrn";
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

/** The derived cross-graph composition for a kit's components. */
export interface AlgoComposition {
  /** The `requires` edges (a component URN → an algorithm URN), deduped, in first-seen order. */
  edges: CrossGraphEdge[];
  /** The UNIQUE referenced library nodes (an algorithm's resolved node, carrying its `code`), in
   *  first-seen order — one band card each. */
  nodes: ResolvedNode[];
}

/**
 * Derive the `requires` edges + referenced library nodes for `comps` from their `@bsc/<segment>/<name>`
 * imports. Only references that RESOLVE to a runnable node (one carrying `code`) are included — an
 * unresolvable `@bsc/…/<missing>` is a graphHealth finding, not a graph node. Deterministic. Pure.
 */
export function resolveComponentAlgoRefs(comps: readonly ComponentRecord[]): AlgoComposition {
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
