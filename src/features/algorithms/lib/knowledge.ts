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

/** Per-tech display label + file extension (the impl id suffix: `<concept>.<ext>`) + rail dot color (a
 *  per-language identifier, the Algorithms analog of a Designs kit's `dot`; distinct from the impl role
 *  dots `--violet`/`--accent`). */
export const TECH_META: Record<Tech, { label: string; ext: string; dot: string }> = {
  typescript: { label: "TypeScript", ext: "ts", dot: "var(--info)" },
  rust: { label: "Rust", ext: "rs", dot: "var(--state-wait)" },
};

/** The tier of an implementation within a language kit (#2863): a `primitive` is a base language
 *  building block (`java.stream`, `rust.iterator`, `merge`); an `algorithm` composes primitives +
 *  simpler algorithms into something more complicated. This is the "base vs growing" distinction the
 *  rail groups by. */
export type ImplRole = "primitive" | "algorithm";

/**
 * A concept-implementation within a language kit (#2770/#2863) — the unit of a language kit (like a
 * component in a Designs kit): a real thing, in one `tech`, WITH code. `role` splits **primitives**
 * (the language's building blocks — free-standing, no `concept`) from **algorithms** (which `composes`
 * OTHER impls of the SAME tech to grow up, e.g. `merge-sort.ts` composes `merge.ts`). A `primitive`
 * `pairs` with its algorithm counterparts (a Java `Stream` pairs a sort/search). `id` is `<name>.<ext>`.
 */
export interface AlgoImpl {
  /** `<name>.<ext>` — e.g. "merge-sort.rs", "java.stream". */
  id: string;
  /** The concept this realizes — a real node id. OPTIONAL (#2863): a free-standing PRIMITIVE (a pure
   *  language building block) has no concept. */
  concept?: string;
  tech: Tech;
  /** The tier (#2863) — `primitive` (base building block) or `algorithm` (composed). */
  role: ImplRole;
  name: string;
  summary?: string;
  /** OTHER implementation ids of the same tech this builds on (the "builds on" edges). */
  composes: string[];
  /** Paired counterparts of the same tech (#2863) — a primitive's algorithm counterparts / an
   *  algorithm's primitives (a Java `Stream` pairs the sort/search it powers). */
  pairs?: string[];
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

/** The raw graph document shape — `@data/knowledge/algorithms.json` and `bsc graph dump` (#2853): nodes
 *  WITHOUT the derived `provenance`, which {@link buildKnowledge} stamps. */
export interface RawKnowledge {
  nodes: Omit<KnowledgeNode, "provenance">[];
  edges: KnowledgeEdge[];
  implementations?: AlgoImpl[];
}

/** Build the model from a raw graph document — stamps every node `provenance: "seed"` (the curated
 *  ontology; Phase 2's extracted nodes carry `"extracted"`) and defaults missing implementations to [].
 *  Shared by the packaged seed AND the live hydrate from the writable store (#2856), so both produce the
 *  identical model. Pure. */
export function buildKnowledge(raw: RawKnowledge): KnowledgeGraph {
  return {
    nodes: raw.nodes.map((n) => ({ ...n, provenance: "seed" as const })),
    edges: raw.edges,
    implementations: raw.implementations ?? [],
  };
}

/** The packaged seed graph — the fast-first-paint fallback + the ONE source `bsc graph` embeds. The live
 *  Algorithms view hydrates from the writable store (`bsc graph dump`, #2856) over this. */
export const KNOWLEDGE: KnowledgeGraph = buildKnowledge(RAW as unknown as RawKnowledge);

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

/** An implementation by its id (e.g. "merge-sort.rs"), or `undefined`. */
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

// ── Language kits (#2863) — a kit is every implementation of one `tech`; navigation groups a kit by
// `role` (primitives → algorithms) the way the Designs rail groups a kit by component role. ──

/** The techs that carry at least one implementation — the language kits present, in {@link TECHS}
 *  order first, then any others in seed order. */
export function kitTechs(graph: KnowledgeGraph): Tech[] {
  const seen = graph.implementations.map((im) => im.tech);
  const ordered = TECHS.filter((t) => seen.includes(t));
  const extras = seen.filter((t, i) => seen.indexOf(t) === i && !ordered.includes(t));
  return [...ordered, ...extras];
}

/** Every implementation in a language kit (all impls of `tech`), in seed order. */
export function kitImpls(graph: KnowledgeGraph, tech: Tech): AlgoImpl[] {
  return graph.implementations.filter((im) => im.tech === tech);
}

/** A kit's implementations of one `role` (its primitives, or its algorithms). */
export function kitImplsByRole(graph: KnowledgeGraph, tech: Tech, role: ImplRole): AlgoImpl[] {
  return graph.implementations.filter((im) => im.tech === tech && im.role === role);
}

/** The impls this one `pairs` with (same tech), resolved to the impl objects. */
export function pairsOf(graph: KnowledgeGraph, impl: AlgoImpl): AlgoImpl[] {
  const ids = new Set(impl.pairs ?? []);
  return graph.implementations.filter((im) => ids.has(im.id));
}

// ── The language-folder rail model (#2899) — mirror the Designs rail (kitGroups.ts): each LANGUAGE is a
// folder (like each technology is a folder in Components), its impls the rows. Pure, so the rail render +
// tests share one model. Replaces the kits-index card layer (the wrong-direction navigation). ──

/** A language folder in the Algorithms rail — a `tech` and its implementations (primitives first). */
export interface AlgoLangGroup {
  tech: Tech;
  label: string;
  /** Stable expand-state key (`lang:<tech>`). */
  key: string;
  /** The folder-head color dot — the per-language identifier (#2902), like a Designs kit's `dot`. */
  dot: string;
  /** The kit's impls, primitives before algorithms, each in seed order. */
  impls: AlgoImpl[];
}

/** Group the implementations into one folder per language (#2899) — the rail tree. Languages in
 *  {@link kitTechs} order; within a folder, primitives lead the algorithms (the "base then grows up"
 *  reading). Pure + deterministic. */
export function groupImplsByLanguage(graph: KnowledgeGraph): AlgoLangGroup[] {
  return kitTechs(graph).map((tech) => ({
    tech,
    label: TECH_META[tech]?.label ?? tech,
    key: `lang:${tech}`,
    dot: TECH_META[tech]?.dot ?? "var(--fg-muted)",
    impls: [...kitImplsByRole(graph, tech, "primitive"), ...kitImplsByRole(graph, tech, "algorithm")],
  }));
}

// ── The per-kit graph (#2863) — the kit's OWN graph: nodes are its implementations (a concept IS its
// implementation), wired by `composes` (builds-on) + `pairs`, PLUS the concept ontology's semantic
// relationships (operates-on, variant-of, generates, related-to) LIFTED onto the concrete impls so the
// per-language graph keeps the ontology's meaning without any abstract concept blocks. Per-language, not
// deduped: each kit renders only its own impls. This is what a kit's center graph draws. ──

/** A per-kit edge relationship — the ontology rels plus `pairs` (the primitive↔algorithm counterpart link). */
export type KitRel = KnowledgeRel | "pairs";

/** Per-kit-rel display label + edge style — the ontology rels (from {@link REL_META}) plus `pairs`. Shared
 *  by the kit-graph canvas AND the on-graph legend (#2909) so the key never drifts from the drawn edges. */
export const KIT_REL_META: Record<KitRel, { label: string; dashed?: boolean; doubleEnded?: boolean }> = {
  ...REL_META,
  pairs: { label: "pairs", dashed: true, doubleEnded: true },
};

/** The order kit-rel legend rows read in (composes/pairs first — the kit's own edges — then lifted ontology rels). */
export const KIT_REL_ORDER: KitRel[] = ["composes", "pairs", "operates-on", "variant-of", "generates", "related-to"];

/** An edge in a kit graph — endpoints are implementation ids (not concept ids). */
export interface KitEdge { from: string; to: string; rel: KitRel }

/** A language kit as its own graph: the kit's impls + the edges between them. */
export interface KitGraph { nodes: AlgoImpl[]; edges: KitEdge[] }

/**
 * Build a kit's own graph (#2863) from `graph.implementations`, scoped to `tech`. Edges:
 *  - `composes` — each impl → the same-tech impls it builds on (the "grows up" edges).
 *  - `pairs` — undirected counterpart links (a primitive ↔ the algorithm it powers), deduped to one edge.
 *  - lifted ontology rels — a concept-level `A —rel→ B` becomes `impl(A) —rel→ impl(B)` when BOTH concepts
 *    have an impl in this kit (rel other than `composes`, which is already an impl-level edge). So the kit
 *    graph inherits operates-on / variant-of / generates / related-to between the concrete impls.
 * Pure.
 */
export function kitGraph(graph: KnowledgeGraph, tech: Tech): KitGraph {
  const nodes = kitImpls(graph, tech);
  const ids = new Set(nodes.map((n) => n.id));
  const edges: KitEdge[] = [];
  for (const im of nodes) {
    for (const c of im.composes) if (ids.has(c)) edges.push({ from: im.id, to: c, rel: "composes" });
  }
  const seenPair = new Set<string>();
  for (const im of nodes) {
    for (const p of im.pairs ?? []) {
      if (!ids.has(p)) continue;
      const key = im.id < p ? `${im.id}|${p}` : `${p}|${im.id}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      edges.push({ from: im.id, to: p, rel: "pairs" });
    }
  }
  const implOfConcept = new Map<string, string>();
  for (const n of nodes) if (n.concept) implOfConcept.set(n.concept, n.id);
  for (const e of graph.edges) {
    if (e.rel === "composes") continue; // already represented at the impl level
    const from = implOfConcept.get(e.from), to = implOfConcept.get(e.to);
    if (from && to && from !== to) edges.push({ from, to, rel: e.rel });
  }
  return { nodes, edges };
}

/** Per-impl "compose depth" within a kit: a primitive is the base (0); an algorithm is 1 + the deepest
 *  in-kit impl it composes (min 1). Drives the left→right column layout ("grows up" reads as it deepens).
 *  Cycle-guarded (composes shouldn't cycle, but a bad kit won't hang). */
function composeDepth(kit: KitGraph): Map<string, number> {
  const byId = new Map(kit.nodes.map((n) => [n.id, n]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    const node = byId.get(id);
    if (!node || node.role === "primitive") { memo.set(id, 0); return 0; }
    if (visiting.has(id)) return 1; // cycle guard
    visiting.add(id);
    const composed = node.composes.filter((c) => byId.has(c));
    const d = composed.length ? 1 + Math.max(...composed.map(depth)) : 1;
    visiting.delete(id);
    memo.set(id, d);
    return d;
  };
  for (const n of kit.nodes) depth(n.id);
  return memo;
}

/** Lay a kit graph out in columns by {@link composeDepth} (primitives at the base, algorithms deepening
 *  right), stacked in seed order within a column. Same {@link KnowledgeLayout} shape as the concept graph
 *  (positions keyed by impl id), so the SAME canvas/viewport draw it. Pure + deterministic. */
export function layoutKitGraph(kit: KitGraph): KnowledgeLayout {
  const depths = composeDepth(kit);
  const pos = new Map<string, NodePos>();
  const maxDepth = Math.max(0, ...kit.nodes.map((n) => depths.get(n.id) ?? 0));
  const rowByCol = new Array<number>(maxDepth + 1).fill(0);
  for (const n of kit.nodes) {
    const col = depths.get(n.id) ?? 0;
    const row = rowByCol[col]++;
    pos.set(n.id, { x: PAD + col * COL_PITCH, y: PAD + row * ROW_PITCH });
  }
  const maxRows = Math.max(0, ...rowByCol);
  const cols = maxDepth + 1;
  const world = {
    w: PAD * 2 + (cols - 1) * COL_PITCH + NODE_W,
    h: PAD * 2 + Math.max(maxRows - 1, 0) * ROW_PITCH + NODE_H,
  };
  const bounds: Box = { x: PAD, y: PAD, w: world.w - PAD * 2, h: world.h - PAD * 2 };
  return { pos, world, bounds };
}
