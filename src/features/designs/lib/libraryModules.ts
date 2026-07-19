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
//   • `sound` → the project's PINNED sound kit (#3412) — the blueprint's `soundKit` pin, resolved out of
//     the versioned release store, is the resolution target. A `@bsc/sounds/<id>` is kit-less, so it
//     resolves against whichever single kit {@link SoundKitSelection} names (#3117). The Rust twin
//     (`graph_health.rs`) takes the SAME kit through `HealthOptions::sound_kit_json`, so both sides agree.
//   • `ui` has no vendor path in this slice, so it doesn't resolve here (its imports stay honestly
//     unresolvable until #3118/#3119).
//
// SOUND-KIT SELECTION — ONE DEFAULT, TWO LOUD FAILURES (#3412; no silent fallback anywhere):
//   • no pin        → {@link STARTER_KIT}, the packaged default. This is the DOCUMENTED default, not a
//     fallback: an unpinned project resolves exactly as it did before #3412.
//   • pin resolved  → that kit, and ONLY that kit.
//   • pin UNRESOLVABLE (missing artifact / corrupt release / bridge failure) → the sound arm is DROPPED,
//     so every `@bsc/sounds/…` fails to resolve and surfaces as an unresolvable import. It deliberately
//     does NOT degrade to the starter kit: the user cannot HEAR that the wrong kit loaded, so a silent
//     degrade is undetectable by the only sense that would catch it (and it would contradict the
//     never-a-silent-fallback rule #3372 enforces for the pin itself).
//   A pinned kit that lacks the referenced cue fails the same way an unknown reference always has — no
//   per-cue fallback, because a half-pinned component would bleed two kits' palettes together with
//   nothing surfacing that its sound is mixed. A kit is adopted wholesale (epic #3071).
//
// Pure + React-free. The DEFAULT resolvers below read the packaged seeds ({@link KNOWLEDGE} /
// {@link BUILTIN_KITS}); a pinned kit arrives as injected state via {@link makeLibraryResolvers}, whose
// product is param-injected into the pure `componentPreviewFiles` so that module never imports a store.
import { makeUrnResolver, type NodeLookup, type ResolvedNode, type UrnResolver } from "@/shared/lib/graph/crossGraph";
import { formatNodeUrn, parseLibrarySpec, LIBRARY_ROOT, LIBRARY_SEGMENT, type NodeGraph } from "@/shared/lib/graph/nodeUrn";
import { KNOWLEDGE, algoNodeLookup } from "@/features/algorithms";
import { BUILTIN_KITS, STARTER_KIT, soundNodeLookup, type SoundKit } from "@/features/sounds";
import type { LibraryModuleResolver } from "./componentPreview";

/**
 * WHICH sound kit `@bsc/sounds/…` resolves against — the injected state that replaced the old module-level
 * const (#3412). See the SOUND-KIT SELECTION note above for the policy behind each arm.
 */
export type SoundKitSelection =
  /** No blueprint pin — the packaged {@link STARTER_KIT}. The documented default, not a fallback. */
  | { kind: "default" }
  /** The blueprint's pin, resolved to its artifact. `ref` is `id@version` (for messages). */
  | { kind: "pinned"; ref: string; kit: SoundKit }
  /** A pin that could NOT be resolved. Nothing sound-shaped resolves — fail loudly, never a starter degrade. */
  | { kind: "unresolved"; ref: string; error: string };

/** The no-pin selection — the packaged default kit. A shared const so callers can compare identity. */
export const DEFAULT_SOUND_KIT: SoundKitSelection = { kind: "default" };

/** The resolver pair {@link makeLibraryResolvers} produces for one {@link SoundKitSelection}. */
export interface LibraryResolvers {
  /** See {@link resolveLibrarySpec} — bound to this selection's sound kit. */
  resolveLibrarySpec: (spec: string) => ResolvedNode | null;
  /** See {@link libraryModuleResolver} — bound to this selection's sound kit. */
  libraryModuleResolver: LibraryModuleResolver;
}

/** The sound graph's `{ kit, lookup }`, or `null` when NOTHING sound-shaped may resolve (an unresolvable
 *  pin). Dropping the arm — rather than substituting the starter kit — is what makes a broken pin loud. */
function soundArm(sound: SoundKitSelection): { kit: string; lookup: NodeLookup } | null {
  switch (sound.kind) {
    case "default":
      return { kit: STARTER_KIT.id, lookup: soundNodeLookup(BUILTIN_KITS) };
    case "pinned":
      // Scoped to the pinned kit ALONE: a cue the pin lacks must miss, never fall through to a built-in.
      return { kit: sound.kit.id, lookup: soundNodeLookup([sound.kit]) };
    case "unresolved":
      return null;
  }
}

/**
 * Build the library resolvers for one {@link SoundKitSelection} (#3412). Algorithms always resolve against
 * the TYPESCRIPT kit (a JS/TS preview can only vendor + run a TS impl); the sound arm follows the pin.
 *
 * Cheap but not free (it rebuilds the per-graph lookups), so callers hold the result across renders —
 * `useMemo` on the selection, not a fresh call per resolve.
 */
export function makeLibraryResolvers(sound: SoundKitSelection = DEFAULT_SOUND_KIT): LibraryResolvers {
  const arm = soundArm(sound);
  const kitForGraph: Partial<Record<NodeGraph, string>> = { algo: "typescript", ...(arm ? { sound: arm.kit } : {}) };
  const lookupForGraph: Partial<Record<NodeGraph, NodeLookup>> = {
    algo: algoNodeLookup(KNOWLEDGE),
    ...(arm ? { sound: arm.lookup } : {}),
  };
  const resolver: UrnResolver = makeUrnResolver(lookupForGraph);

  const resolveSpec = (spec: string): ResolvedNode | null => {
    const parsed = parseLibrarySpec(spec);
    if (!parsed) return null;
    const kit = kitForGraph[parsed.graph];
    const lookup = lookupForGraph[parsed.graph];
    if (!kit || !lookup) return null;
    // First resolve to the node to learn its CANONICAL id (so both name forms canonicalize to one URN),
    // then resolve THROUGH the shared resolver (A) so identity is minted the one canonical way.
    const found = lookup(kit, parsed.name);
    if (!found) return null;
    const urn = formatNodeUrn(parsed.graph, kit, found.id);
    return urn ? resolver(urn) : null;
  };

  return { resolveLibrarySpec: resolveSpec, libraryModuleResolver: makeModuleResolver(resolveSpec) };
}

/** The DEFAULT (no-pin) resolvers — built once over the packaged seeds. Every caller that has no project
 *  context resolves through these, so unpinned behavior is byte-identical to pre-#3412. */
const DEFAULT_RESOLVERS: LibraryResolvers = makeLibraryResolvers(DEFAULT_SOUND_KIT);

/**
 * Resolve a `@bsc/<segment>/<name>` library import specifier to its cross-graph {@link ResolvedNode}, or
 * `null` when it isn't a `@bsc/…` spec, targets a graph with no vendor path here, or names no such node.
 * For `algo`, `name` accepts the bare name (`fibonacci`) OR the exact id (`fibonacci.ts`); for `sound`, it
 * is the cue/voice/primitive id (`click`). The returned node's `urn` is CANONICAL (built from the resolved
 * node's id), so both name forms of an algorithm resolve to ONE node (one band card, one edge target).
 *
 * Bound to the packaged DEFAULT sound kit. A caller with project context resolves the blueprint's pin
 * instead, via {@link makeLibraryResolvers} (#3412).
 */
export function resolveLibrarySpec(spec: string): ResolvedNode | null {
  return DEFAULT_RESOLVERS.resolveLibrarySpec(spec);
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
export const libraryModuleResolver: LibraryModuleResolver = (spec: string) =>
  DEFAULT_RESOLVERS.libraryModuleResolver(spec);

/** Build the {@link LibraryModuleResolver} over one selection's spec resolver — the shared body behind both
 *  the default export above and every pin-bound resolver {@link makeLibraryResolvers} hands out. */
function makeModuleResolver(resolveSpec: (spec: string) => ResolvedNode | null): LibraryModuleResolver {
  return (spec: string) => {
    const node = resolveSpec(spec);
    if (!node || !node.code) return null;
    const source = ensureExport(node.code, node.label);
    const path = /\.(ts|tsx|js|jsx)$/.test(spec) ? spec : `${spec}.ts`;
    return { path, source };
  };
}

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
