// The Algorithms knowledge graph — pure model (#2761, epic #2760). React/Tauri-free so the tests, the
// page render, and (Phase 2) the extraction lift all share ONE model. This is "Graph 1": the curated
// concept ontology (data structures, algorithms, concepts, outputs) joined by typed relationships,
// loaded from the packaged seed (@data/knowledge/algorithms.json — the SAME source `bsc graph` embeds).
//
// Layout is deterministic: nodes column by `kind` (data-structure → algorithm → concept → output),
// stacked in seed order within a column, so the graph reads left→right as structures feed algorithms
// which rest on concepts which produce outputs. Selection lights a node + its neighbors (the shared
// "focus dims the rest" idea); the kind filter dims a whole column. Phase 2 (#2745) adds `provenance:
// "extracted"` nodes + the `implements` join — hence `provenance` rides the model now.
import RAW from "@data/knowledge/algorithms.json";

/** The four node kinds — also the left→right column order of the layout. */
export type KnowledgeKind = "data-structure" | "algorithm" | "concept" | "output";

/** The typed relationships between concepts. */
export type KnowledgeRel = "operates-on" | "composes" | "variant-of" | "generates" | "related-to";

/** Where a node came from (#2760). Seeded knowledge now; `extracted` from code is Phase 2 (#2745). */
export type Provenance = "seed" | "extracted";

export interface KnowledgeNode {
  id: string;
  kind: KnowledgeKind;
  name: string;
  summary: string;
  /** Big-O label — meaningful on `algorithm` nodes; absent elsewhere. */
  complexity?: string;
  tags?: string[];
  provenance: Provenance;
}

export interface KnowledgeEdge {
  from: string;
  to: string;
  rel: KnowledgeRel;
}

/** The languages a concept can carry a per-tech implementation in (#2770). */
export type Tech = "typescript" | "rust";

/** The implementation techs, in display order. */
export const TECHS: Tech[] = ["typescript", "rust"];

/** Per-tech display label + file extension (the impl id suffix: `<concept>.<ext>`). */
export const TECH_META: Record<Tech, { label: string; ext: string }> = {
  typescript: { label: "TypeScript", ext: "ts" },
  rust: { label: "Rust", ext: "rs" },
};

/**
 * A per-tech implementation of a concept (#2770) — the second tier over the shared concept spine.
 * Mirrors the Designs component/kit system: a language-specific, shareable component that `implements`
 * one concept and `composes` OTHER implementations of the SAME tech to build more complicated
 * algorithms (e.g. `merge-sort.ts` composes `merge.ts`). `id` is `<concept>.<ext>` (ext = ts | rs).
 */
export interface AlgoImpl {
  /** `<concept>.<ext>` — e.g. "merge-sort.ts". */
  id: string;
  /** The concept node id this implements (a real node in `nodes`). */
  concept: string;
  tech: Tech;
  name: string;
  summary?: string;
  /** OTHER implementation ids of the same tech this builds on (the "builds on" edges). */
  composes: string[];
  /** A real, concise implementation in `tech`. */
  code: string;
}

export interface KnowledgeGraph {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  /** The per-tech implementation tier (#2770). Empty when the seed carries no implementations. */
  implementations: AlgoImpl[];
}

/** Left→right column order; every node lands in exactly one column by `kind`. */
export const KIND_ORDER: KnowledgeKind[] = ["data-structure", "algorithm", "concept", "output"];

/** Per-kind display label + accent token (app design tokens, not raw colors). */
export const KIND_META: Record<KnowledgeKind, { label: string; color: string }> = {
  "data-structure": { label: "Data structures", color: "var(--info)" },
  algorithm: { label: "Algorithms", color: "var(--accent)" },
  concept: { label: "Concepts", color: "var(--violet)" },
  output: { label: "Outputs", color: "var(--success)" },
};

/** Per-relationship display label + edge style. `dashed`/`doubleEnded` drive the shared `graphEdge`. */
export const REL_META: Record<KnowledgeRel, { label: string; dashed?: boolean; doubleEnded?: boolean }> = {
  "operates-on": { label: "operates on" },
  composes: { label: "composes" },
  "variant-of": { label: "variant of" },
  generates: { label: "generates" },
  "related-to": { label: "related", dashed: true, doubleEnded: true },
};

/** Node box size (world px) — shared by the layout and the canvas card. */
export const NODE_W = 172;
export const NODE_H = 58;
const COL_PITCH = NODE_W + 208;
const ROW_PITCH = NODE_H + 22;
const PAD = 48;

/** The packaged seed graph — every node stamped `provenance: "seed"` (the JSON stays clean; Phase 2's
 *  extracted nodes carry `"extracted"`). This is the ONE source of truth, also embedded by `bsc graph`. */
export const KNOWLEDGE: KnowledgeGraph = (() => {
  const raw = RAW as unknown as {
    nodes: Omit<KnowledgeNode, "provenance">[];
    edges: KnowledgeEdge[];
    implementations?: AlgoImpl[];
  };
  return {
    nodes: raw.nodes.map((n) => ({ ...n, provenance: "seed" as const })),
    edges: raw.edges,
    implementations: raw.implementations ?? [],
  };
})();

/** A stable id for an edge — `from~rel~to` (a pair can carry more than one relationship). */
export function edgeId(e: KnowledgeEdge): string {
  return `${e.from}~${e.rel}~${e.to}`;
}

/** A node's laid-out position (top-left, world coords). */
export interface NodePos { x: number; y: number }

/** A design-space box — matches the viewport's `GraphBox` so it can drive `contentBounds`. */
export interface Box { x: number; y: number; w: number; h: number }

export interface KnowledgeLayout {
  pos: Map<string, NodePos>;
  world: { w: number; h: number };
  /** The bounding box of the actual nodes — framed by `fit()` so the graph centers on content. */
  bounds: Box;
}

/**
 * Column-by-kind layout: one column per {@link KIND_ORDER} entry, nodes stacked in seed order. Pure +
 * deterministic (no randomness), so the render and the tests agree. Empty kinds collapse (no gap column).
 */
export function layoutKnowledge(nodes: KnowledgeNode[]): KnowledgeLayout {
  const pos = new Map<string, NodePos>();
  const columns = KIND_ORDER.map((k) => nodes.filter((n) => n.kind === k)).filter((c) => c.length);
  let maxRows = 0;
  columns.forEach((col, colIndex) => {
    maxRows = Math.max(maxRows, col.length);
    col.forEach((n, rowIndex) => {
      pos.set(n.id, { x: PAD + colIndex * COL_PITCH, y: PAD + rowIndex * ROW_PITCH });
    });
  });
  const cols = Math.max(columns.length, 1);
  const world = {
    w: PAD * 2 + (cols - 1) * COL_PITCH + NODE_W,
    h: PAD * 2 + Math.max(maxRows - 1, 0) * ROW_PITCH + NODE_H,
  };
  const bounds: Box = { x: PAD, y: PAD, w: world.w - PAD * 2, h: world.h - PAD * 2 };
  return { pos, world, bounds };
}

/** The focused node + its direct neighbors (either direction) + every edge touching it — the shared
 *  "focus dims the rest" set, computed locally (no coupling to the graph-core edge type). Pure. */
export function neighborsOf(graph: KnowledgeGraph, focusId: string): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>([focusId]);
  const edges = new Set<string>();
  for (const e of graph.edges) {
    if (e.from === focusId) { nodes.add(e.to); edges.add(edgeId(e)); }
    if (e.to === focusId) { nodes.add(e.from); edges.add(edgeId(e)); }
  }
  return { nodes, edges };
}

/** The edges incident to `id`, each paired with the OTHER endpoint's node — what the inspector lists. */
export function relationsOf(graph: KnowledgeGraph, id: string): { edge: KnowledgeEdge; other: KnowledgeNode; dir: "out" | "in" }[] {
  const byId = nodeIndex(graph.nodes);
  const out: { edge: KnowledgeEdge; other: KnowledgeNode; dir: "out" | "in" }[] = [];
  for (const e of graph.edges) {
    if (e.from === id) { const other = byId.get(e.to); if (other) out.push({ edge: e, other, dir: "out" }); }
    else if (e.to === id) { const other = byId.get(e.from); if (other) out.push({ edge: e, other, dir: "in" }); }
  }
  return out;
}

/** id → node map. */
export function nodeIndex(nodes: KnowledgeNode[]): Map<string, KnowledgeNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/**
 * Shortest relationship path between two nodes (BFS over the UNDIRECTED graph — relationships are
 * navigable both ways). Returns the node-id chain inclusive of both ends, or `null` if unreachable /
 * an unknown id. Used by the inspector and `bsc graph path`.
 */
export function pathBetween(graph: KnowledgeGraph, a: string, b: string): string[] | null {
  const has = nodeIndex(graph.nodes);
  if (!has.has(a) || !has.has(b)) return null;
  if (a === b) return [a];
  const adj = new Map<string, string[]>();
  const link = (x: string, y: string) => { (adj.get(x) ?? adj.set(x, []).get(x)!).push(y); };
  for (const e of graph.edges) { link(e.from, e.to); link(e.to, e.from); }
  const prev = new Map<string, string>();
  const seen = new Set<string>([a]);
  const q: string[] = [a];
  while (q.length) {
    const cur = q.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      if (next === b) {
        const path = [b];
        let step = b;
        while (step !== a) { step = prev.get(step)!; path.unshift(step); }
        return path;
      }
      q.push(next);
    }
  }
  return null;
}

// ── The per-tech implementation tier (#2770) — pure lookups over `graph.implementations`. ──

/** Every implementation of a concept (any tech), in seed order. */
export function implsForConcept(graph: KnowledgeGraph, conceptId: string): AlgoImpl[] {
  return graph.implementations.filter((im) => im.concept === conceptId);
}

/** The implementation of a concept in a given tech, or `undefined` if none is seeded. */
export function implFor(graph: KnowledgeGraph, conceptId: string, tech: Tech): AlgoImpl | undefined {
  return graph.implementations.find((im) => im.concept === conceptId && im.tech === tech);
}

/** An implementation by its id (e.g. "merge-sort.ts"), or `undefined`. */
export function implById(graph: KnowledgeGraph, id: string): AlgoImpl | undefined {
  return graph.implementations.find((im) => im.id === id);
}

/** The techs that carry an implementation of a concept, in {@link TECHS} order. */
export function techsWithImpl(graph: KnowledgeGraph, conceptId: string): Tech[] {
  return TECHS.filter((t) => graph.implementations.some((im) => im.concept === conceptId && im.tech === t));
}

/** The implementations that `compose` `implId` — the reverse of `composes` ("used by"). */
export function usedByImpl(graph: KnowledgeGraph, implId: string): AlgoImpl[] {
  return graph.implementations.filter((im) => im.composes.includes(implId));
}
