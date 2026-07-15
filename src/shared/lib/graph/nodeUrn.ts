// Cross-graph node addressing (#3115, epic #3114) — the universal "part number" that lets a node in one
// kit graph (Algorithms / Designs / Sounds) reference a node in ANOTHER. Today the three graphs are
// siloed: `composes` only resolves inside one kit of one pillar, so a UI component that needs `fibonacci`
// re-codes it. This module is the pure, feature-agnostic substrate that makes a cross-graph reference
// EXPRESSIBLE — the URN grammar + the reserved import-namespace mapping. Resolution + the `requires` edge
// live in ./crossGraph; the feature wiring (which store to look in) lives in the consuming features.
//
// React/Tauri-free and it imports NO feature code (this is `shared/`) — the three pillars stay decoupled
// from each other; each just adapts its own store to the generic resolver in ./crossGraph.

/** The three kit-graph pillars a node can live in. The URN's leading token. */
export type NodeGraph = "algo" | "ui" | "sound";

/** All graphs, in display order. */
export const NODE_GRAPHS: NodeGraph[] = ["algo", "ui", "sound"];

/** The reserved npm-style root for a library import (`@bsc/<segment>/<name>`). Chosen so it can never
 *  collide with a real package a user installs, and so the existing import resolver can key on it. */
export const LIBRARY_ROOT = "@bsc";

/** graph → the `@bsc/<segment>` path segment used in a library import specifier. */
export const LIBRARY_SEGMENT: Record<NodeGraph, string> = { algo: "algorithms", ui: "ui", sound: "sounds" };

/** The reverse of {@link LIBRARY_SEGMENT} — an import path segment back to its graph. */
const SEGMENT_GRAPH: Record<string, NodeGraph> = { algorithms: "algo", ui: "ui", sounds: "sound" };

/** The decomposed parts of a node URN `<graph>:<kit>/<id>`. */
export interface NodeUrnParts {
  graph: NodeGraph;
  /** The kit the node lives in — a language for algorithms (`typescript`), a kit id for designs/sounds. */
  kit: string;
  /** The node's in-kit id (`fibonacci.ts`, `Sparkline`, `click`). May itself contain `/`. */
  id: string;
}

/** Is `g` one of the known graphs? (Type guard.) */
export function isNodeGraph(g: string): g is NodeGraph {
  return (NODE_GRAPHS as string[]).includes(g);
}

/**
 * Format a node URN — `<graph>:<kit>/<id>`, e.g. `algo:typescript/fibonacci.ts`, `ui:react-ui/Sparkline`,
 * `sound:default/click`. Returns null if any component is empty (so callers can't mint a malformed URN).
 */
export function formatNodeUrn(graph: NodeGraph, kit: string, id: string): string | null {
  if (!isNodeGraph(graph) || !kit || !id) return null;
  return `${graph}:${kit}/${id}`;
}

/**
 * Parse a node URN back into its parts, or null when it doesn't match `<graph>:<kit>/<id>` with a known
 * graph and non-empty kit + id. Tolerant: never throws (malformed input → null). `kit` is the segment up
 * to the FIRST `/`; `id` is everything after it (so an id may contain `/`, though today none do).
 */
export function parseNodeUrn(urn: string): NodeUrnParts | null {
  if (typeof urn !== "string") return null;
  const colon = urn.indexOf(":");
  if (colon <= 0) return null;
  const graph = urn.slice(0, colon);
  if (!isNodeGraph(graph)) return null;
  const rest = urn.slice(colon + 1);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null; // need a non-empty kit before the first '/'
  const kit = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  if (!kit || !id) return null;
  return { graph, kit, id };
}

/** Is `s` a well-formed node URN? */
export function isNodeUrn(s: string): boolean {
  return parseNodeUrn(s) !== null;
}

/** A library import specifier `@bsc/<segment>/<name>` — the KIT-LESS reference a component author writes
 *  (`import { fibonacci } from "@bsc/algorithms/fibonacci"`). The consuming store picks the kit (a TS
 *  component resolves an algorithm in the `typescript` kit), so a spec carries only graph + name. */
export interface LibrarySpec {
  graph: NodeGraph;
  /** The node name/id as written in the import (`fibonacci` or `fibonacci.ts` — the resolver accepts both). */
  name: string;
}

/** Is `spec` under the reserved `@bsc/…` library root? A cheap pre-check before {@link parseLibrarySpec}. */
export function isLibrarySpec(spec: string): boolean {
  return typeof spec === "string" && spec.startsWith(LIBRARY_ROOT + "/");
}

/**
 * Parse a library import specifier `@bsc/<segment>/<name>` into `{ graph, name }`, or null when it isn't
 * a `@bsc/…` spec with a known segment and a non-empty name. `name` keeps any remaining path (e.g. a
 * hypothetical `@bsc/ui/forms/Field` → name `forms/Field`) so ids with `/` survive. Never throws.
 */
export function parseLibrarySpec(spec: string): LibrarySpec | null {
  if (!isLibrarySpec(spec)) return null;
  const after = spec.slice(LIBRARY_ROOT.length + 1); // drop "@bsc/"
  const slash = after.indexOf("/");
  if (slash <= 0) return null;
  const segment = after.slice(0, slash);
  const name = after.slice(slash + 1);
  const graph = SEGMENT_GRAPH[segment];
  if (!graph || !name) return null;
  return { graph, name };
}

/**
 * The canonical library import specifier for a node URN — `@bsc/<segment>/<id>`. The inverse of routing a
 * spec to a node; used to REWRITE an inline reimplementation into a library import (#3118) and to label a
 * cross-graph edge. Returns null for a malformed URN.
 */
export function urnToImportSpec(urn: string): string | null {
  const parts = parseNodeUrn(urn);
  if (!parts) return null;
  return `${LIBRARY_ROOT}/${LIBRARY_SEGMENT[parts.graph]}/${parts.id}`;
}
