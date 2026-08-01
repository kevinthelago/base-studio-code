// Edge batching (#4150) — collapse the graph's edge layer from three SVG elements PER EDGE into one
// merged path per visual class.
//
// Each edge used to render `<g>` + a stroke `<path>` + a filled arrowhead `<path>`: 799 edges on the
// 248-component kit is ~2,400 elements, and ~9,600 at the 1000-component target. SVG path data takes
// MULTIPLE SUBPATHS (`M…L… M…L…`), so lines sharing a stroke are one `<path>` and arrowheads sharing a
// fill are one more.
//
// Two properties make that safe rather than clever:
//   • the edge layer is `pointer-events: none`, so no per-edge element is needed for behaviour;
//   • the non-highlighted bulk all draws identically, so it has no per-edge styling to lose.
//
// The SELECTION-incident edges stay individual — they are few, and they are the ones whose appearance
// actually differs. Pure, so the merge is testable without a DOM.

/** One edge's geometry, as `graphEdge` returns it: the line and its arrowhead, both path `d` strings. */
export interface EdgeGeom {
  /** The line's path data. */
  d: string;
  /** The arrowhead's path data — a closed, filled shape. */
  arrow: string;
}

/** The merged bulk plus the edges held back to render individually. */
export interface EdgeBatch<T> {
  /** Every bulk line concatenated into one path `d`, or `""` when the bulk is empty. */
  d: string;
  /** Every bulk arrowhead concatenated into one path `d`, or `""` when the bulk is empty. */
  arrow: string;
  /** The edges the caller must render itself (the highlighted ones), in input order. */
  individual: T[];
}

/**
 * Split `edges` into a merged bulk and an individual remainder.
 *
 * `geom` returns an edge's geometry, or `null` to DROP it (an endpoint with no laid-out position — the
 * same skip the per-edge render did). `individually` marks the edges to hold back.
 *
 * Concatenating with a space keeps each subpath's leading `M` its own token, so the result is the exact
 * sequence of subpaths the separate elements drew — merging changes the element COUNT, never the pixels.
 *
 * Filled arrowheads merge under the default nonzero winding rule: separate closed triangles each fill,
 * and two that overlap simply paint the same colour twice.
 */
export function batchEdges<T>(
  edges: readonly T[],
  geom: (edge: T) => EdgeGeom | null,
  individually: (edge: T) => boolean = () => false,
): EdgeBatch<T> {
  const lines: string[] = [];
  const arrows: string[] = [];
  const individual: T[] = [];
  for (const e of edges) {
    const g = geom(e);
    if (!g) continue; // an endpoint with no position — dropped, exactly as before
    if (individually(e)) {
      individual.push(e);
      continue;
    }
    if (g.d) lines.push(g.d);
    if (g.arrow) arrows.push(g.arrow);
  }
  return { d: lines.join(" "), arrow: arrows.join(" "), individual };
}
