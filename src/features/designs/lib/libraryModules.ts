// Library-module resolution (#3116, epic #3114) — the Design Studio's bridge from a `@bsc/<segment>/<name>`
// import a component author writes to (a) the resolved cross-graph node (for the requires edge) and (b) a
// VENDORABLE preview module (the algorithm's real `code`), so the live preview runs the LIBRARY impl with
// no inline copy. Composes A's URN grammar (`parseLibrarySpec`/`formatNodeUrn`) + resolver (`makeUrnResolver`)
// over the Algorithms feature's `NodeLookup` adapter — the ONE place the Design Studio decides WHICH kit a
// reference resolves against.
//
// KIT SELECTION: a React (TypeScript) component resolves an `@bsc/algorithms/…` reference against the
// TYPESCRIPT algorithm kit — a JS/TS preview can only vendor + run a TS impl (esbuild can't build Rust).
// Other graphs (`ui`/`sound`) have no vendor path in this slice, so they don't resolve here (their imports
// stay honestly unresolvable until their slices land, #3117/#3119).
//
// Pure + React-free. The default resolvers read the packaged {@link KNOWLEDGE} seed; the mechanism is
// param-injected into the pure `componentPreviewFiles` so that module never imports the algorithms store.
import { makeUrnResolver, type ResolvedNode, type UrnResolver } from "@/shared/lib/graph/crossGraph";
import { formatNodeUrn, parseLibrarySpec, type NodeGraph } from "@/shared/lib/graph/nodeUrn";
import { KNOWLEDGE, algoNodeLookup } from "@/features/algorithms";
import type { LibraryModuleResolver } from "./componentPreview";

/** Which kit a library reference resolves against, per graph. A React/TS component wants the `typescript`
 *  algorithm kit (the only kit vendorable into a JS preview). Absent graphs don't resolve in this slice. */
const KIT_FOR_GRAPH: Partial<Record<NodeGraph, string>> = { algo: "typescript" };

/** The `algo`-graph lookup over the packaged seed, and the composed URN resolver (A's `makeUrnResolver`). */
const ALGO_LOOKUP = algoNodeLookup(KNOWLEDGE);
const RESOLVER: UrnResolver = makeUrnResolver({ algo: ALGO_LOOKUP });

/**
 * Resolve a `@bsc/<segment>/<name>` library import specifier to its cross-graph {@link ResolvedNode}, or
 * `null` when it isn't a `@bsc/…` spec, targets a graph with no vendor path here, or names no such node.
 * `name` accepts the bare name (`fibonacci`) OR the exact id (`fibonacci.ts`). The returned node's `urn` is
 * CANONICAL (built from the resolved impl's id), so `@bsc/algorithms/fibonacci` and `@bsc/algorithms/fibonacci.ts`
 * resolve to ONE node (one band card, one edge target).
 */
export function resolveLibrarySpec(spec: string): ResolvedNode | null {
  const parsed = parseLibrarySpec(spec);
  if (!parsed) return null;
  const kit = KIT_FOR_GRAPH[parsed.graph];
  if (!kit) return null;
  // First resolve to the impl to learn its CANONICAL id (so both name forms canonicalize to one URN),
  // then resolve THROUGH the shared resolver (A) so identity is minted the one canonical way.
  const found = ALGO_LOOKUP(kit, parsed.name);
  if (!found) return null;
  const urn = formatNodeUrn(parsed.graph, kit, found.id);
  return urn ? RESOLVER(urn) : null;
}

/**
 * The default {@link LibraryModuleResolver} for the Design Studio preview: resolve `spec` and, when it names
 * a node carrying reusable `code`, return the vendorable preview module — the file `path` the import
 * resolves to (the literal specifier + a `.ts` extension unless it already has one, so the mem bundler's
 * TS loader handles it) + the module `source`. `null` when the spec doesn't resolve or the target has no
 * code (a primitive descriptor is not importable). ONE source of truth — the component holds no copy.
 *
 * The vendored source is the algorithm's `code` verbatim. A TS algorithm's `code` is authored as a
 * self-contained ES module that EXPORTS its public symbol (see the `fibonacci.ts` seed), so the import
 * binds directly. As a safety net for a bare-function `code` (no `export`), we append `export { <name> };`
 * so the named import still resolves — documented here because the store, not this module, owns the code.
 */
export const libraryModuleResolver: LibraryModuleResolver = (spec: string) => {
  const node = resolveLibrarySpec(spec);
  if (!node || !node.code) return null;
  const source = ensureExport(node.code, node.label);
  const path = /\.(ts|tsx|js|jsx)$/.test(spec) ? spec : `${spec}.ts`;
  return { path, source };
};

/** Ensure a vendored module EXPORTS `name` for the bootstrap/importer to bind: verbatim when it already
 *  declares any `export`, else the code plus a trailing `export { <name> };` (the bare-function safety net). */
function ensureExport(code: string, name: string): string {
  if (/\bexport\b/.test(code)) return code;
  return `${code.replace(/\s*$/, "")}\nexport { ${name} };\n`;
}
