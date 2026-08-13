// A MODULE SYSTEM for graph records (epic #3604) — the replacement for vendoring.
//
// Before this, `componentLoader` treated every record as *source to re-bundle*: `loaderPlugin` pulled
// each graph sibling INTO the entry's esbuild build, recursively, so a page and its panels compiled as
// one module. That has three costs, and they compound:
//   - mounting a page recompiles the page AND its whole subtree, every mount (the host has no compiled
//     cache — only the last-good render gate);
//   - editing one leaf invalidates every ancestor that vendored it;
//   - a record vendored into two parents becomes TWO module instances, which is why a registry with
//     load-bearing module-init side effects (`stageScreens`) could not be migrated.
//
// The fix is to treat records as MODULES. The obstacle is that `require` has to be synchronous while
// esbuild-wasm is asynchronous, so this splits into two phases — which is what a linker is:
//
//   1. LINK (async, [`linkGraphModules`]) — compile the entry standalone with every import external,
//      scan the emitted `require("…")` specifiers, ask the resolver which are records, compile those,
//      recurse. Compilation is memoized by EXACT SOURCE TEXT, so an unchanged record never recompiles.
//   2. EVAL (sync, [`makeGraphRequire`]) — a Node-style `require` over the linked set: graph module
//      first, then the app registry, then a named error.
//
// Scanning the COMPILED output rather than the TSX is deliberate: esbuild already emits exactly one
// `require()` per external import, so there is no second import parser to keep in sync with the first.
//
// SCOPE NOTE — the evaluated-exports cache is per LOAD, not global. That keeps module-instance
// semantics identical to vendoring (one instance per page load), so this slice changes performance and
// invalidation WITHOUT changing identity. Making instances global is a real improvement and a separate
// decision: it is what would let `stageScreens` migrate, and it deserves its own slice rather than
// riding along invisibly inside a performance change.

/** One linked graph module: the source it came from and the CommonJS esbuild produced for it. */
export interface LinkedModule {
  specifier: string;
  source: string;
  cjs: string;
}

/** Compile one self-standing module's source to CommonJS with every import left external. Injected so
 *  the linker is unit-testable without esbuild (the real compile is browser-only). */
export type CompileFn = (source: string) => Promise<string>;

/** Resolve a specifier to a graph record's source, or `null`/`undefined` when it is not a record. Same
 *  contract as the loader's `GraphSourceResolver` — one resolver, so `provides` overrides (#3660) and
 *  `@/components/<id>` siblings both keep working here. */
export type SourceResolver = (specifier: string) => string | null | undefined;

/**
 * Every specifier the compiled module `require`s. Matches the `require("x")` / `require('x')` calls
 * esbuild emits for external imports.
 *
 * Deliberately a scan of the OUTPUT, not the input: the output has one call per external import in a
 * single fixed shape, whereas the input is TSX with type-only imports, re-exports and side-effect
 * imports that a hand-rolled parser gets wrong. #4188 and #4224 each removed a static check that was
 * more permissive than the runtime; this avoids adding a third.
 *
 * Duplicates are collapsed and order is preserved (first occurrence wins), so a caller can rely on it
 * for a deterministic link order.
 */
export function scanRequires(cjs: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of cjs.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = m[1];
    if (!seen.has(spec)) {
      seen.add(spec);
      out.push(spec);
    }
  }
  return out;
}

/** The process-wide compile cache, keyed `specifier` + NUL + `source` (a NUL separator, so a
 *  specifier containing the delimiter cannot forge another entry's key). Keying on the EXACT source (not just
 *  the specifier) is what makes it safe to keep forever: an edited record is a different key, so a
 *  stale entry is unreachable rather than wrong. */
const compileCache = new Map<string, string>();

const cacheKey = (specifier: string, source: string) => `${specifier}\u0000${source}`;

/** Compile through the cache. Exported for the loader so the ENTRY is memoized on the same terms as
 *  its dependencies — the entry is the one a host re-mounts most often. */
export async function compileCached(specifier: string, source: string, compile: CompileFn): Promise<string> {
  const key = cacheKey(specifier, source);
  const hit = compileCache.get(key);
  if (hit !== undefined) return hit;
  const cjs = await compile(source);
  compileCache.set(key, cjs);
  return cjs;
}

/** How many records are compiled in the cache — diagnostics + the test that proves a second mount
 *  compiles nothing. */
export function compileCacheSize(): number {
  return compileCache.size;
}

/** Drop the compile cache (tests, and a hard reset path). */
export function __resetCompileCache(): void {
  compileCache.clear();
}

/** The specifier the entry module is linked under. Not a real import path — nothing can `require` it,
 *  which is the point: the entry is reachable only as the link root. */
export const ENTRY_SPECIFIER = "\u0000graph-entry";

/**
 * LINK PHASE. Compile `entrySource` and, transitively, every graph record it reaches, returning the
 * linked set keyed by specifier. The entry is present under {@link ENTRY_SPECIFIER}.
 *
 * Traversal is breadth-first over a `seen` set, so an import CYCLE between records terminates here as
 * well as during eval — a cycle is a normal shape for modules and must not hang the linker.
 *
 * A specifier the resolver does not claim is left alone: it stays external and `require` resolves it
 * against the app registry at eval time. That is what keeps platform modules (React, the store, the
 * registered primitives) as the single live instance they have to be.
 */
export async function linkGraphModules(
  entrySource: string,
  resolveSource: SourceResolver | undefined,
  compile: CompileFn,
): Promise<Map<string, LinkedModule>> {
  const linked = new Map<string, LinkedModule>();
  const entryCjs = await compileCached(ENTRY_SPECIFIER, entrySource, compile);
  linked.set(ENTRY_SPECIFIER, { specifier: ENTRY_SPECIFIER, source: entrySource, cjs: entryCjs });

  const queue = scanRequires(entryCjs);
  const seen = new Set<string>();
  while (queue.length) {
    const spec = queue.shift() as string;
    if (seen.has(spec) || linked.has(spec)) continue;
    seen.add(spec);
    const source = resolveSource?.(spec);
    if (source == null) continue; // not a record → external → the app registry answers it
    const cjs = await compileCached(spec, source, compile);
    linked.set(spec, { specifier: spec, source, cjs });
    queue.push(...scanRequires(cjs));
  }
  return linked;
}

/** One override the prune declined, for the caller to log. `specifier` is the module the record claimed;
 *  `missing` is the first specifier in its closure that nothing could answer. */
export interface DeclinedOverride {
  specifier: string;
  missing: string;
}

/** What {@link pruneUnsatisfiableOverrides} produced: the linked set to evaluate, and what it declined. */
export interface PruneResult {
  linked: Map<string, LinkedModule>;
  declined: DeclinedOverride[];
}

/**
 * PRUNE PHASE — decline a graph module whose own closure cannot be resolved, so `require` falls back to
 * the platform module it was overriding instead of the page dying.
 *
 * THE FAILURE THIS EXISTS FOR. `provides` is a GLOBAL override and resolution is graph-first (#3660), so
 * a record claiming `@/shared/hooks/usePageTabs` wins over the registered one everywhere. That is correct
 * when the record can stand on its own — and catastrophic when it cannot: a harvested module whose own
 * imports were never registered takes down EVERY page whose closure touches that specifier. Measured on
 * a live store: 67 of 544 overrides in that state, and the two that mattered killed Glance and Console
 * outright ("`glancepage` failed to load: import `@/shared/lib/core/arrayMove` is not a registered app
 * module").
 *
 * An override that cannot resolve its own imports is not a working override. Declining it is not a
 * workaround for a bad record — it is the honest reading of what the record can currently deliver.
 *
 * ONLY WHERE THERE IS A FALLBACK. A module is declined only if `isAvailable(specifier)` — i.e. the
 * platform genuinely has something to answer with. A specifier with no registered module (a
 * `@/components/<id>` sibling, an entry) is left in place so the page still fails loudly; inventing a
 * fallback that does not exist would turn a named error into a blank screen.
 *
 * ONE PASS, and the reason it needs no fixed point is the load-bearing insight: a dependency that is
 * ITSELF available can never be the cause of a failure. If module A imports B and B is an override with
 * a platform fallback, then B resolves either as a graph module or — if B is declined too — as the
 * bundled one. Either way A's import of B resolves, so the walk stops at B instead of inheriting its
 * problems. Only a dependency with NO fallback (a `@/components/<id>` sibling) propagates, and those are
 * never declined, so the outcome is stable after a single sweep and independent of map order.
 *
 * Getting this wrong is not academic: descending through available dependencies declines A as well as B,
 * which silently reverts a perfectly good migration because something one hop away was broken.
 *
 * Pure: a map plus a predicate. No esbuild, no DOM, no store — which is what lets the rule be tested.
 */
export function pruneUnsatisfiableOverrides(
  linked: Map<string, LinkedModule>,
  isAvailable: (specifier: string) => boolean,
): PruneResult {
  const kept = new Map(linked);
  const declined: DeclinedOverride[] = [];

  /** The first specifier in `spec`'s closure that nothing can answer, or null when it is satisfiable.
   *  `seen` guards an import CYCLE, which is a normal module shape the linker and the eval cache both
   *  already tolerate. */
  const firstUnreachable = (spec: string): string | null => {
    const seen = new Set<string>([spec]);
    const queue = [...scanRequires(linked.get(spec)?.cjs ?? "")];
    while (queue.length) {
      const dep = queue.shift() as string;
      if (seen.has(dep)) continue;
      seen.add(dep);
      // Has a fallback ⇒ always resolvable ⇒ stop here (see the one-pass note above).
      if (isAvailable(dep)) continue;
      const mod = linked.get(dep);
      // No fallback and not a graph module ⇒ nothing can answer it. This is the failure.
      if (!mod) return dep;
      // No fallback but IS a graph module (a sibling) ⇒ its failure is our failure; keep walking.
      queue.push(...scanRequires(mod.cjs));
    }
    return null;
  };

  for (const spec of kept.keys()) {
    // The ENTRY is never declined: it is the thing being loaded, it overrides nothing, and there is no
    // module to fall back to. Its unresolved imports are a real failure and must still throw.
    if (spec === ENTRY_SPECIFIER) continue;
    // Nothing to fall back to ⇒ leave it in place and let the page fail loudly. Declining here would
    // swap a named error for a blank screen.
    if (!isAvailable(spec)) continue;
    const missing = firstUnreachable(spec);
    if (missing) declined.push({ specifier: spec, missing });
  }
  for (const d of declined) kept.delete(d.specifier);
  return { linked: kept, declined };
}

/** Evaluate CommonJS with an injected `require`, returning its `module.exports`. Kept here (rather than
 *  reusing the loader's) so the eval + cache insertion order below is one readable unit. */
function evaluate(cjs: string, require: (s: string) => unknown): Record<string, unknown> {
  const module = { exports: {} as Record<string, unknown> };
  // `new Function` runs graph-authored code in the app context — the premise of graph-as-source (#3604),
  // and the reason every mount is wrapped in an error boundary + fallback.
  const factory = new Function("require", "module", "exports", cjs);
  factory(require, module, module.exports);
  return module.exports;
}

/**
 * EVAL PHASE. Build the `require` a linked module runs against.
 *
 * Resolution order — **graph first**, which is what keeps `provides` overrides (#3660) working: a
 * record that provides `@/shared/ui/Button` must win over the bundled Button, and it only can if the
 * graph is consulted before the registry.
 *
 *   1. an already-evaluated graph module → its exports
 *   2. a linked-but-not-yet-evaluated graph module → evaluate it now
 *   3. `appRequire` — the registry, which throws a NAMED error for an unregistered specifier
 *
 * CYCLE SAFETY, Node's rule: the module's `exports` object is placed in the cache BEFORE its factory
 * runs, so a module that (transitively) requires itself gets the partially-filled object instead of
 * recursing forever. That is exactly how CommonJS has always behaved, including its one sharp edge —
 * a cyclic importer sees whatever was assigned before the cycle closed.
 */
export function makeGraphRequire(
  linked: Map<string, LinkedModule>,
  appRequire: (specifier: string) => unknown,
): (specifier: string) => unknown {
  const evaluated = new Map<string, Record<string, unknown>>();

  const require = (specifier: string): unknown => {
    const done = evaluated.get(specifier);
    if (done !== undefined) return done;
    const mod = linked.get(specifier);
    if (!mod) return appRequire(specifier);
    const exports: Record<string, unknown> = {};
    evaluated.set(specifier, exports); // BEFORE evaluating — the cycle guard
    const produced = evaluate(mod.cjs, require);
    // esbuild's CJS output assigns `module.exports = …` wholesale, so the object the factory ends up
    // with is usually NOT the one seeded above. Copy the result onto the seeded object so a cyclic
    // importer that already captured the seed still observes the finished exports.
    if (produced !== exports) {
      Object.assign(exports, produced);
      evaluated.set(specifier, produced);
    }
    return evaluated.get(specifier);
  };

  return require;
}

/** Evaluate the linked entry and return its exports — the whole eval phase in one call. */
export function evaluateEntry(
  linked: Map<string, LinkedModule>,
  appRequire: (specifier: string) => unknown,
): Record<string, unknown> {
  const require = makeGraphRequire(linked, appRequire);
  return require(ENTRY_SPECIFIER) as Record<string, unknown>;
}
