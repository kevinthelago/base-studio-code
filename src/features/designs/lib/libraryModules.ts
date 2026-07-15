// Library-module resolution (#3116, epic #3114) — the Design Studio's bridge from a `@bsc/<segment>/<name>`
// import a component author writes to (a) the resolved cross-graph node (for the requires edge) and (b) a
// VENDORABLE preview module (the algorithm's real `code`), so the live preview runs the LIBRARY impl with
// no inline copy. Composes A's URN grammar (`parseLibrarySpec`/`formatNodeUrn`) + resolver (`makeUrnResolver`)
// over the Algorithms feature's `NodeLookup` adapter — the ONE place the Design Studio decides WHICH kit a
// reference resolves against.
//
// KIT SELECTION — the ONE place the Design Studio decides WHICH kit a kit-less `@bsc/<segment>/<name>`
// reference resolves against, per graph:
//   • `algo`  → the TYPESCRIPT algorithm kit — a JS/TS preview can only vendor + run a TS impl (esbuild
//     can't build Rust).
//   • `sound` → the DEFAULT sound kit — the first packaged built-in ({@link STARTER_KIT}, currently
//     `signal`). A `@bsc/sounds/<id>` is kit-less, so it resolves against that one default kit (#3117). The
//     Rust twin (`graph_health.rs`) embeds that SAME kit's seed; a test pins `signal` on BOTH sides so they
//     stay in lockstep if the default ever changes.
//   • `ui` has no vendor path in this slice, so it doesn't resolve here (its imports stay honestly
//     unresolvable until #3118/#3119).
//
// Pure + React-free. The default lookups read the packaged seeds ({@link KNOWLEDGE} / {@link BUILTIN_KITS});
// the mechanism is param-injected into the pure `componentPreviewFiles` so that module never imports a store.
import { makeUrnResolver, type NodeLookup, type ResolvedNode, type UrnResolver } from "@/shared/lib/graph/crossGraph";
import { formatNodeUrn, parseLibrarySpec, type NodeGraph } from "@/shared/lib/graph/nodeUrn";
import { KNOWLEDGE, algoNodeLookup } from "@/features/algorithms";
import { BUILTIN_KITS, STARTER_KIT, soundNodeLookup } from "@/features/sounds";
import type { LibraryModuleResolver } from "./componentPreview";

/** Which kit a library reference resolves against, per graph (see the KIT SELECTION note above). A React/TS
 *  component wants the `typescript` algorithm kit; a sound reference resolves against the default sound kit
 *  (the first built-in). Absent graphs (`ui`) don't resolve in this slice. */
const KIT_FOR_GRAPH: Partial<Record<NodeGraph, string>> = { algo: "typescript", sound: STARTER_KIT.id };

/** The per-graph {@link NodeLookup}s over the packaged seeds, and the composed URN resolver (A's
 *  `makeUrnResolver`). A graph absent here (or a lookup miss) resolves to `null`. */
const LOOKUP_FOR_GRAPH: Partial<Record<NodeGraph, NodeLookup>> = {
  algo: algoNodeLookup(KNOWLEDGE),
  sound: soundNodeLookup(BUILTIN_KITS),
};
const RESOLVER: UrnResolver = makeUrnResolver(LOOKUP_FOR_GRAPH);

/**
 * Resolve a `@bsc/<segment>/<name>` library import specifier to its cross-graph {@link ResolvedNode}, or
 * `null` when it isn't a `@bsc/…` spec, targets a graph with no vendor path here, or names no such node.
 * For `algo`, `name` accepts the bare name (`fibonacci`) OR the exact id (`fibonacci.ts`); for `sound`, it
 * is the cue/voice/primitive id (`click`). The returned node's `urn` is CANONICAL (built from the resolved
 * node's id), so both name forms of an algorithm resolve to ONE node (one band card, one edge target).
 */
export function resolveLibrarySpec(spec: string): ResolvedNode | null {
  const parsed = parseLibrarySpec(spec);
  if (!parsed) return null;
  const kit = KIT_FOR_GRAPH[parsed.graph];
  const lookup = LOOKUP_FOR_GRAPH[parsed.graph];
  if (!kit || !lookup) return null;
  // First resolve to the node to learn its CANONICAL id (so both name forms canonicalize to one URN),
  // then resolve THROUGH the shared resolver (A) so identity is minted the one canonical way.
  const found = lookup(kit, parsed.name);
  if (!found) return null;
  const urn = formatNodeUrn(parsed.graph, kit, found.id);
  return urn ? RESOLVER(urn) : null;
}

/**
 * The default {@link LibraryModuleResolver} for the Design Studio preview: resolve `spec` and, when it names
 * a node carrying reusable `code`, return the vendorable preview module — the file `path` the import
 * resolves to (the literal specifier + a `.ts` extension unless it already has one, so the mem bundler's
 * TS loader handles it) + the module `source`. `null` when the spec doesn't resolve or the target has no
 * code (a primitive descriptor — an algorithm OR a sound primitive — is not importable). ONE source of
 * truth — the component holds no copy.
 *
 * The vendored source is graph-specific: for an ALGORITHM it's the impl's `code` VERBATIM — a self-contained
 * ES module that EXPORTS its public symbol (see the `fibonacci.ts` seed), so the import binds directly; for
 * a SOUND cue/voice it's the SELF-CONTAINED player module synthesized at resolve time (`cuePlayerModule`,
 * #3117), which exports `play`. Both already declare an `export`, so the bare-function safety net below is a
 * no-op for them; it only kicks in for a bare-function algorithm `code` (append `export { <name> };`).
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
