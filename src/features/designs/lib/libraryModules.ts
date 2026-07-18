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
//     DELIBERATELY NOT the blueprint's `soundKit` pin yet (#3372 shipped the pin as CONFIG; making it the
//     RESOLUTION target is #3412). The blocker is shape, not wiring: this resolver is a module-level const
//     over packaged seeds, while a pin resolves ASYNCHRONOUSLY through the `bsc` bridge — so the kit must
//     become injected state, the Rust twin must move in lockstep, and the unresolvable-pin/missing-cue
//     fallback needs an explicit policy. Tracked, not implicit.
//   • `ui` has no vendor path in this slice, so it doesn't resolve here (its imports stay honestly
//     unresolvable until #3118/#3119).
//
// Pure + React-free. The default lookups read the packaged seeds ({@link KNOWLEDGE} / {@link BUILTIN_KITS});
// the mechanism is param-injected into the pure `componentPreviewFiles` so that module never imports a store.
import { makeUrnResolver, type NodeLookup, type ResolvedNode, type UrnResolver } from "@/shared/lib/graph/crossGraph";
import { formatNodeUrn, parseLibrarySpec, LIBRARY_ROOT, LIBRARY_SEGMENT, type NodeGraph } from "@/shared/lib/graph/nodeUrn";
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

/** One LIBRARY NODE a Design Studio component could RE-CODE instead of importing (#3118, epic #3114) — a
 *  candidate for the "compose, don't recreate" guardrail. `name` is the exact identifier a
 *  reimplementation would DECLARE (an algorithm's bare name); `segment` is the `@bsc/<segment>` import
 *  root the node lives under (always `algorithms` — see {@link libraryReimplTargets}); `importSpec` is the
 *  exact `@bsc/…` library import to compose instead. */
export interface LibraryReimplTarget {
  /** The identifier a reimplementation would declare — the match key against a declared symbol. */
  name: string;
  /** The node's `@bsc/<segment>` import root — `algorithms` (the only reimplementation segment). */
  segment: string;
  /** The exact library import to compose instead — `@bsc/<segment>/<name>`. */
  importSpec: string;
}

/** Is `s` a single valid JS identifier (so it COULD be a declared symbol)? Excludes empty, a leading
 *  digit, and any non-`[A-Za-z0-9_$]` char — so a library name that can never appear as `function <name>`
 *  (an extension-bearing algo id like `fibonacci.ts`) is not a reimplementation candidate. Kept in
 *  lockstep with the Rust twin `is_js_identifier`. */
function isJsIdentifier(s: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
}

/**
 * The library nodes a component could RE-CODE (#3118) — the TYPESCRIPT algorithm kit's algorithm impls,
 * matched by their bare NAME. A node is listed IFF `@bsc/algorithms/<name>` resolves (via
 * {@link resolveLibrarySpec}), so the guardrail only ever steers to a real, vendorable library node.
 *
 * ALGORITHMS-ONLY BY DESIGN. Sounds are DELIBERATELY excluded even though `@bsc/sounds/<id>` resolves +
 * vendors (#3117 — that import path stays fully intact): a sound cue/voice id (`click`, `toggle`, `error`,
 * `success`, `pop`, `tick`, …) collides with extremely common handler/function names, so a component that
 * legitimately declares `function click()` would be wrongly flagged — and you don't "re-code" a cue as a
 * function anyway (the asymmetry: you inline an ALGORITHM like fibonacci/dijkstra, not a sound). The value
 * is asymmetric and the false-positive cost high, so the reimplementation detector matches algorithms only.
 *
 * Excluded from the algorithm set too: a primitive descriptor (a language built-in / raw source —
 * DESCRIBED, not re-coded, #2972; carries no `code`) and a non-identifier name (which can never be a
 * declared symbol). Pure; reads the packaged seed. Deduped by `importSpec`. Rust twin: `reimpl_targets`.
 */
export function libraryReimplTargets(): LibraryReimplTarget[] {
  const out: LibraryReimplTarget[] = [];
  const seen = new Set<string>();
  const add = (name: string, segment: string) => {
    if (!isJsIdentifier(name)) return;
    const importSpec = `${LIBRARY_ROOT}/${segment}/${name}`;
    if (seen.has(importSpec)) return;
    seen.add(importSpec);
    out.push({ name, segment, importSpec });
  };
  // Algorithms only (see the ALGORITHMS-ONLY note above): the TS kit's algorithm impls that ship real,
  // reusable `code` (a primitive is a language built-in — DESCRIBED, not re-coded, #2972 — so it has no
  // `code` and is excluded). Matched by the bare NAME a reimplementation declares (`fibonacci`), not the
  // extension-bearing id (`fibonacci.ts`).
  for (const im of KNOWLEDGE.implementations) {
    if (im.tech === "typescript" && im.role === "algorithm" && im.code?.trim()) add(im.name, LIBRARY_SEGMENT.algo);
  }
  return out;
}
