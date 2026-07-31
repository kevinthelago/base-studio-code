// The Algorithms knowledge graph — pure model (#2761, epic #2760). React/Tauri-free so the tests, the
// page render, and the harvest lift all share ONE model. PRIMITIVES-ROOTED, impl-is-concept
// (#2958/#2961): each language kit is a graph of its implementations, rooted in that language's
// PRIMITIVES (Vec, Iterator, …) with algorithms composing UP from them. There is NO abstract concept
// layer — a node IS a concrete implementation. Loaded from the packaged seed
// (@data/knowledge/algorithms.json — the SAME source `bsc graph` embeds).
import RAW from "@data/knowledge/algorithms.json";

/** The languages a kit can be in (#2770). */
export type Tech = "typescript" | "rust";

/** The implementation techs, in display order. */
export const TECHS: Tech[] = ["typescript", "rust"];

/** Per-tech display label + file extension (an algorithm impl's id suffix) + rail dot color (a
 *  per-language identifier, the Algorithms analog of a Designs kit's `dot`). */
export const TECH_META: Record<Tech, { label: string; ext: string; dot: string }> = {
  typescript: { label: "TypeScript", ext: "ts", dot: "var(--info)" },
  rust: { label: "Rust", ext: "rs", dot: "var(--state-wait)" },
};

/** The tier of an implementation within a language kit (#2863/#2958): a `primitive` is a LANGUAGE
 *  built-in (`rust.iterator`, `rust.vec`); an `algorithm` composes primitives + simpler algorithms up.
 *  This is the "base vs growing" distinction the rail groups by. */
export type ImplRole = "primitive" | "algorithm";

/**
 * A unit of a language kit (#2863/#2958) — a node in one `tech`. The implementation IS the concept:
 * there is no abstract concept node. `role` splits **primitives** — a language BUILT-IN (`rust.vec`,
 * `rust.iterator`) that is DESCRIBED by its std `ref`, never re-coded (#2972) — from **algorithms**:
 * real reusable `code` that `compose`s OTHER impls of the SAME tech, growing UP from the primitive base
 * (e.g. `merge-sort.rs` composes `merge.rs`, `rust.vec`, `rust.slice`). `id` is `<name>.<ext>` for an
 * algorithm, `<tech>.<name>` for a primitive.
 */
/** The manipulation KINDS an algorithm can carry (#3210, epic #3209) — the "what it does" axis of the
 *  animation (`sort`/`search`/…), paired with the DATA STRUCTURE it operates on to pick the live
 *  visualization. Grows as more example animations land (matrix ops, etc.). */
export const ALGO_KINDS = ["sort", "search", "traversal", "accumulate", "transform"] as const;
export type AlgoKind = (typeof ALGO_KINDS)[number];

export interface AlgoImpl {
  /** `<name>.<ext>` (algorithm) or `<tech>.<name>` (primitive) — e.g. "merge-sort.rs", "rust.iterator". */
  id: string;
  tech: Tech;
  /** The tier (#2863) — `primitive` (a language built-in) or `algorithm` (composed). */
  role: ImplRole;
  name: string;
  summary?: string;
  /** OTHER implementation ids of the same tech this builds on — the "builds on" edges, pointing DOWN
   *  to the primitive base. */
  composes: string[];
  /** A primitive's std reference — the language built-in it names (`std::vec::Vec`, `i64`). Primitives
   *  are DESCRIBED, not re-coded (#2972); algorithms leave this unset. */
  ref?: string;
  /** An algorithm's real, reusable implementation in `tech`. Optional for a primitive — a language
   *  built-in is described (`ref` + `summary`), not re-coded (#2972). */
  code?: string;
  /** PROVENANCE (#4091/#4107) — the scanned-root-relative path of the file this was harvested from.
   *  The Rust mirror is `AlgoImpl.src`. Absent on anything authored before it (every seeded impl). */
  src?: string;
  /** The FOLDER (#4107) — the nested, `/`-delimited path this impl organizes under, derived from
   *  {@link src} by the SAME derivation components use (`bsc_util::folder_from_src`). Harvest is 1:1:
   *  the folder mirrors where the code actually lives, so the library reads like the tree it came from.
   *  Absent ⇒ the impl is UNFOLDERED and the rail lists it directly under its language. */
  folder?: string;
  /** Optional DOMAIN facet (#3120) — the lightweight, cross-language collection this impl belongs to
   *  (e.g. "logistics", "graphics"). ADDITIVE + backward-compatible: impls authored before the facet
   *  existed have no `domain` and are simply absent from every domain collection, so nothing breaks. A
   *  domain cross-cuts language, so a domain app can pull its relevant subset of the library — all
   *  `logistics` algorithms, across languages. Curated via `bsc graph impl set --domain <d>`. */
  domain?: string;
  /** Optional free-form tags (#3120) — additive keywords for search / cross-cutting collections. Absent
   *  on existing impls; curated via `bsc graph impl set --tags a,b,c`. */
  tags?: string[];
  /** Optional KIND facet (#3210) — the manipulation this algorithm performs (`sort`/`search`/…), the
   *  "what it does" axis that (with its data structure) selects the live animation. ADDITIVE + backward-
   *  compatible: the CREATOR assigns it (`bsc graph impl set --kind sort`), and a heuristic classifier
   *  fills it for untyped impls; absent on impls authored before the facet, so nothing breaks. */
  kind?: AlgoKind;
  /** Optional VIZ-CODE facet (#3218, epic #3215) — the algorithm's VISUALIZATION as data: a JS
   *  trace-program the executor (#3232) runs to DERIVE the animation from the real algorithm. It is a JS
   *  EXPRESSION evaluating to a self-describing descriptor `{ datatype, input, run }` — `datatype` is
   *  `"array" | "matrix" | "graph"` (picks the renderer + input seam), `input` is the default input, and
   *  `run(structure)` is the algorithm written against the matching Traced<Structure> API. The visualizable
   *  form of an impl whose reference `code` can't run in the browser (e.g. Rust). ADDITIVE; the librarian
   *  authors it (`bsc graph impl set --viz-code`). Absent (or malformed) ⇒ the impl falls back to an in-app
   *  trace-program (the sort family / matrix transforms / graph traversals) or shows no animation. */
  vizCode?: string;
}

/** The knowledge model — the per-language implementation tier (#2958); the abstract concept ontology
 *  (nodes/edges) was removed with #2961 (a node IS its implementation). */
export interface KnowledgeGraph {
  implementations: AlgoImpl[];
}

/** The raw graph document shape — `@data/knowledge/algorithms.json` and `bsc graph dump` (#2853). */
export interface RawKnowledge {
  implementations?: AlgoImpl[];
}

/** Build the model from a raw graph document, defaulting missing implementations to []. Shared by the
 *  packaged seed AND the live hydrate from the writable store (#2856), so both produce the identical
 *  model. Pure. */
export function buildKnowledge(raw: RawKnowledge): KnowledgeGraph {
  return { implementations: raw.implementations ?? [] };
}

/** The packaged seed graph — the fast-first-paint fallback + the ONE source `bsc graph` embeds. The live
 *  Algorithms view hydrates from the writable store (`bsc graph dump`, #2856) over this. */
export const KNOWLEDGE: KnowledgeGraph = buildKnowledge(RAW as unknown as RawKnowledge);

// ── The per-tech implementation tier — pure lookups over `graph.implementations`. ──

/** An implementation by its id (e.g. "merge-sort.rs"), or `undefined`. */
export function implById(graph: KnowledgeGraph, id: string): AlgoImpl | undefined {
  return graph.implementations.find((im) => im.id === id);
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

// ── The domain facet (#3120) — a lightweight, cross-language collection tag. A domain (e.g. "logistics")
// cross-cuts language, so a domain app can pull its relevant subset of the library. ADDITIVE: impls
// without a `domain` are absent from every domain collection, so nothing that exists today breaks. Pure
// lookups over `graph.implementations`, so the rail render + the tests share one model. ──

/** The distinct domains present in the library, in a stable (alphabetical, case-insensitive) order.
 *  Impls without a `domain` contribute nothing; the result is empty when the library carries no domain
 *  facet (so the rail can hide the domain affordance entirely). Pure + deterministic. */
export function domainsOf(graph: KnowledgeGraph): string[] {
  const seen = new Set<string>();
  for (const im of graph.implementations) {
    const d = im.domain?.trim();
    if (d) seen.add(d);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Every implementation tagged with `domain`, in seed order — ACROSS languages, since a domain
 *  cross-cuts tech (the "all logistics algorithms" collection). Empty for a blank/unknown domain. Pure. */
export function implsByDomain(graph: KnowledgeGraph, domain: string): AlgoImpl[] {
  const d = domain.trim();
  if (!d) return [];
  return graph.implementations.filter((im) => im.domain === d);
}

/** A language kit's implementations tagged with `domain` (per-tech ∩ per-domain) — mirrors
 *  {@link kitImplsByRole}. Lets a caller narrow a single language folder to a domain collection while
 *  keeping the language-folder structure intact. Pure. */
export function kitImplsByDomain(graph: KnowledgeGraph, tech: Tech, domain: string): AlgoImpl[] {
  const d = domain.trim();
  if (!d) return [];
  return graph.implementations.filter((im) => im.tech === tech && im.domain === d);
}

// ── The language-folder rail model (#2899) — mirror the Designs rail (kitGroups.ts): each LANGUAGE is a
// folder (like each technology is a folder in Components), its impls the rows. Pure, so the rail render +
// tests share one model. ──

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

/** One node of a language's FOLDER TREE (#4107) — a folder with its subfolders and the impls directly
 *  inside it. Mirrors the Components rail's nested tree rather than the single language level the
 *  Algorithms rail had, which left all 50 Rust impls flat in one folder. */
export interface AlgoFolderNode {
  /** The folder's own segment (`pty`), for display. */
  name: string;
  /** The full `/`-delimited path (`src-tauri/src/console/pty`) — a stable key + the open-state id. */
  path: string;
  children: AlgoFolderNode[];
  /** Impls sitting DIRECTLY in this folder, not in a subfolder. */
  impls: AlgoImpl[];
}

/**
 * Build a language's nested folder tree from its impls' {@link AlgoImpl.folder} paths.
 *
 * Impls with no folder come back in `unfoldered` rather than being bucketed under a `""` node — the
 * same choice the derivation makes when a path has no directory, and it keeps a seeded (pre-#4107)
 * library rendering exactly as it does today instead of collapsing it under one blank folder.
 *
 * Pure, so the tree shape is testable without a render.
 */
export function folderTree(impls: readonly AlgoImpl[]): { roots: AlgoFolderNode[]; unfoldered: AlgoImpl[] } {
  const roots: AlgoFolderNode[] = [];
  const unfoldered: AlgoImpl[] = [];
  const byPath = new Map<string, AlgoFolderNode>();

  const ensure = (path: string): AlgoFolderNode => {
    const hit = byPath.get(path);
    if (hit) return hit;
    const segs = path.split("/");
    const name = segs[segs.length - 1] ?? path;
    const node: AlgoFolderNode = { name, path, children: [], impls: [] };
    byPath.set(path, node);
    if (segs.length === 1) roots.push(node);
    else ensure(segs.slice(0, -1).join("/")).children.push(node);
    return node;
  };

  for (const im of impls) {
    const folder = im.folder?.trim();
    if (!folder) { unfoldered.push(im); continue; }
    ensure(folder).impls.push(im);
  }

  // Stable order: folders alphabetically, impls primitives-then-name (the rail's existing convention).
  const sortNode = (n: AlgoFolderNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.impls.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "primitive" ? -1 : 1));
    n.children.forEach(sortNode);
  };
  roots.sort((a, b) => a.name.localeCompare(b.name));
  roots.forEach(sortNode);
  return { roots, unfoldered };
}

// ── The per-kit graph (#2863/#2958) — the kit's OWN graph: nodes are its implementations (a concept IS
// its implementation), wired by `composes` (builds-on, pointing down to the primitive base). Per-language,
// not deduped: each kit renders only its own impls. This is what a kit's center graph draws. ──

/** A per-kit edge relationship — just `composes` now the abstract ontology is gone (#2961). */
export type KitRel = "composes";

/** Per-kit-rel display label + edge style. Shared by the kit-graph canvas AND the on-graph legend (#2909)
 *  so the key never drifts from the drawn edges. */
export const KIT_REL_META: Record<KitRel, { label: string; dashed?: boolean; doubleEnded?: boolean }> = {
  composes: { label: "composes" },
};

/** The order kit-rel legend rows read in. */
export const KIT_REL_ORDER: KitRel[] = ["composes"];

/** An edge in a kit graph — endpoints are implementation ids. */
export interface KitEdge { from: string; to: string; rel: KitRel }

/** A language kit as its own graph: the kit's impls + the `composes` edges between them. */
export interface KitGraph { nodes: AlgoImpl[]; edges: KitEdge[] }

/**
 * Build a kit's own graph (#2863/#2958) from `graph.implementations`, scoped to `tech`: each impl → the
 * same-tech impls it `composes` (the "grows up from the primitive base" edges). The abstract concept
 * ontology is gone (#2961), so `composes` is the only edge. Pure.
 */
export function kitGraph(graph: KnowledgeGraph, tech: Tech): KitGraph {
  const nodes = kitImpls(graph, tech);
  const ids = new Set(nodes.map((n) => n.id));
  const edges: KitEdge[] = [];
  for (const im of nodes) {
    for (const c of im.composes) if (ids.has(c)) edges.push({ from: im.id, to: c, rel: "composes" });
  }
  return { nodes, edges };
}

// ── Layout — the kit graph columns by compose depth (primitives at the base, algorithms deepening right). ──

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

/** Node box size (world px) — shared by the layout and the canvas card. */
export const NODE_W = 172;
export const NODE_H = 58;
const COL_PITCH = NODE_W + 208;
const ROW_PITCH = NODE_H + 22;
const PAD = 48;

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
 *  right), stacked in seed order within a column. Positions keyed by impl id, so the SAME canvas/viewport
 *  draw it. Pure + deterministic. */
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
