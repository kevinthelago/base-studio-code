// The runtime component loader (#3605, epic #3604) — compile a component's source FROM THE GRAPH and run
// it in the LIVE app, with its imports wired to the app's real modules ([`moduleRegistry`]).
//
// This is the deliberate OPPOSITE of the preview bundler (`componentBundle.ts`): the preview ISOLATES —
// it stubs React from a CDN and forbids `@/` first-party imports, so a component runs in a sandboxed
// iframe with no access to the real store/hooks. The loader CONNECTS — it keeps every import external and
// resolves it, at run time, to the app's OWN running module, so a loaded page fires real hooks and reads
// live state. That is the whole point: the graph, not the bundler, is the source of the app's UI.
//
// HOW:
//   1. esbuild-wasm transforms the source (JSX → `jsx()` calls) to CommonJS. A PLATFORM import (a
//      registered live module) is marked external — so `import … from "@/store"` becomes `require("@/store")`
//      in the output. A GRAPH-SIBLING import (one the app can resolve to another graph component's source,
//      #3606) is instead VENDORED — esbuild pulls that source into this build and bundles it, recursively —
//      so a page and its panels compile as one module. Anything else stays external.
//   2. The output is evaluated via `new Function("require","module","exports", code)` and handed a
//      `require` that returns the LIVE module from the registry. An unregistered specifier throws a named
//      error (never a silent stub), so a missing platform module surfaces loudly.
//   3. The component export is returned for a host to mount.
//
// `new Function` runs graph-authored code in the app context — the premise of graph-as-source (the graph
// is the user's own app), but the reason a graph render MUST be wrapped in an error boundary + fallback
// (`GraphComponent`), so a bad node can never white-screen the shell.
import type * as Esbuild from "esbuild-wasm";
import type { ComponentType } from "react";
import { ensureEsbuild, PREVIEW_DEFINE, PREVIEW_GLOB_BANNER, rawImportSpec } from "@/shared/lib/preview/componentBundle";
import { resolveAppModule, isAppModule, registeredSpecifiers } from "@/shared/lib/runtime/moduleRegistry";
import { evaluateEntry, linkGraphModules, pruneUnsatisfiableOverrides, type CompileFn } from "./graphModules";
import { log } from "@/shared/lib/core/log";
import { attest, srcHash } from "@/shared/lib/runtime/attest";

/** Resolve a first-party specifier to another graph component's SOURCE (its `srcText`), so the loader can
 *  vendor siblings into one compile. Returns `null`/`undefined` when the specifier is NOT a graph component
 *  (then it stays external → the registry). The app supplies a store-backed resolver; the loader stays
 *  store-agnostic. Sibling specifiers must be absolute (a stable key like `graph:<id>`), not relative —
 *  virtual modules have no directory to resolve `./x` against. */
export type GraphSourceResolver = (specifier: string) => string | null | undefined;

/** How the loader treats an import specifier found in graph source. */
export type ImportKind =
  | "platform" //  a registered live app module (react, @/store, a shared/ui primitive) → external `require`
  | "graph" //     a first-party sibling (`@/…` / relative) NOT registered → a graph component to load (#3606)
  | "library"; //  a bare npm specifier → must ALSO be registered (the app owns the dependency), else error

/**
 * Classify an import specifier. Pure — `registered` is injected so this is unit-testable without the
 * live registry. A registered specifier is always `platform` (the app owns it); an unregistered first-
 * party path is a `graph` sibling; anything else bare is a `library` (which, unresolved, is an error at
 * eval time — the app must register every dependency it lets graph code reach).
 */
export function classifyImport(spec: string, registered: (s: string) => boolean): ImportKind {
  if (registered(spec)) return "platform";
  if (spec.startsWith("@/") || spec.startsWith(".") || spec.startsWith("/")) return "graph";
  return "library";
}

/**
 * Route ONE non-entry import. Everything is EXTERNAL now.
 *
 * A graph sibling used to be VENDORED into its parent's build here — esbuild pulled the sibling's
 * source in and the page compiled as one module. Records are MODULES instead (`graphModules.ts`),
 * linked separately and resolved by `require` at eval time. That is what stops a page recompiling its
 * whole subtree on every mount, and what makes an edit to one leaf invalidate only that leaf.
 *
 * GRAPH-FIRST (#3660) is unchanged, just relocated: the require chain consults the linked graph
 * modules BEFORE the app registry, so a record that PROVIDES a platform specifier still overrides the
 * bundled module. The resolver is not consulted here any more — the linker owns that call.
 *
 * Kept as a named function (rather than inlined into the plugin) because it is the documented seam
 * where import routing is decided, and a test pins that decision without touching esbuild.
 */
export function routeImport(path: string, resolveGraphSource?: GraphSourceResolver): { external: true } {
  void path;
  void resolveGraphSource;
  return { external: true };
}

/** esbuild plugin applying [`routeImport`]: every non-entry import stays external, so the output is one
 *  `require()` per import and the linker can read a module's dependencies straight off it. */
function loaderPlugin(resolveGraphSource?: GraphSourceResolver): Esbuild.Plugin {
  return {
    name: "runtime-loader",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return undefined;
        void routeImport(args.path, resolveGraphSource);
        return { path: args.path, external: true };
      });
    },
  };
}

/**
 * Compile graph `source` (a self-standing module string) to CommonJS. Exported for tests + the loader.
 * `jsx: "automatic"` emits `require("react/jsx-runtime")`, so that MUST be a registered platform module.
 * Every import is left EXTERNAL, so the output carries one `require()` per import — which is exactly
 * what the linker reads to discover a record's dependencies (`graphModules.ts`).
 */
export async function compileToCjs(source: string, resolveGraphSource?: GraphSourceResolver): Promise<string> {
  const esbuild = await ensureEsbuild();
  const result = await esbuild.build({
    stdin: { contents: source, loader: "tsx", sourcefile: "graph-component.tsx" },
    bundle: true,
    format: "cjs",
    write: false,
    jsx: "automatic",
    logLevel: "silent",
    // #81 — the SAME shim the previews use. A record is transcribed from a real module, so a record
    // can carry `import.meta.glob` exactly as `agentProfiles.ts` does; without this the runtime
    // loader throws on it at import time, and this path has no preview to surface the error in.
    define: PREVIEW_DEFINE,
    banner: { js: PREVIEW_GLOB_BANNER },
    plugins: [loaderPlugin(resolveGraphSource)],
  });
  return result.outputFiles?.[0]?.text ?? "";
}

/** The `require` a loaded module runs against — the registry, with a loud error for an unresolved specifier
 *  so a missing platform registration is a named failure, not a silent `undefined` that throws deep in React. */
export function makeRequire(): (specifier: string) => unknown {
  return (specifier: string) => {
    if (isAppModule(specifier)) return resolveAppModule(specifier);
    // #85 — a Vite `?raw` / `?url` import, the same gap the previews have. A record is transcribed from a
    // real module, so it can carry `?raw` exactly as `persona.ts` does; the suffix means it can never be a
    // registered specifier, and without this it dies on the throw below. There is no filesystem here, so
    // the text is empty — but it is a STRING, which is what the importer's contract promised.
    const raw = rawImportSpec(specifier);
    if (raw) return { default: raw.query === "url" ? raw.base : "", __esModule: true };
    throw new Error(
      `runtime loader: import "${specifier}" is not a registered app module. ` +
        `Register it (registerAppModule) or author it as a graph record. Available: ${registeredSpecifiers().join(", ")}`,
    );
  };
}

/** Evaluate compiled CJS with the registry-backed `require`, returning its `module.exports`. Pure over its
 *  inputs (the require is injected) so a test can drive it with a fake registry. */
export function evalCjsModule(cjs: string, require: (s: string) => unknown): Record<string, unknown> {
  const module = { exports: {} as Record<string, unknown> };
  // `new Function` runs graph-authored code in the app context — the feature (#3604); the caller wraps it
  // in an error boundary + fallback (GraphComponent) so a bad module can never white-screen the shell.
  const factory = new Function("require", "module", "exports", cjs);
  factory(require, module, module.exports);
  return module.exports;
}

/**
 * Pick the component export from a loaded module: the export named `prefer` if the caller named one, else
 * a `default` export, else the single exported function (React components are functions). `null` when the
 * module exports no component, or when the pick would be a GUESS.
 *
 * `prefer` exists because a record provides a MODULE and a module can export several primitives — 14 of the
 * 69 manifest primitives share 3 specifiers (`controls/Field` alone exports TextField, TextArea and
 * SelectField). Without it every one of them resolved to whichever function came first, which is how a
 * password field rendered as `<select class="input" type="password" />`.
 *
 * The refusal is narrow on purpose. Demanding an exact name match would disable the graph override for
 * every record whose source uses a default export or a differently-named one — the export name need not
 * equal the primitive name. So a name miss still resolves when the module exports exactly ONE component
 * (unambiguous: that module IS this primitive), and returns `null` only when the caller asked for a name,
 * the module lacks it, and there is more than one candidate to choose between. `null` sends the host to its
 * fallback — the bundled primitive, which is correct — rather than mounting the wrong component.
 */
export function pickComponent(
  exports: Record<string, unknown>,
  prefer?: string,
): ComponentType<Record<string, unknown>> | null {
  const named = prefer ? exports[prefer] : undefined;
  if (typeof named === "function") return named as ComponentType<Record<string, unknown>>;

  // Dedupe by identity: `export default X` alongside `export { X }` is two entries and one component, and
  // that is not the ambiguity this guards against.
  const fns = [...new Set(Object.values(exports).filter((v) => typeof v === "function"))];
  if (prefer && fns.length > 1) return null;
  const cand = typeof exports.default === "function" ? exports.default : fns[0];
  return typeof cand === "function" ? (cand as ComponentType<Record<string, unknown>>) : null;
}

/**
 * Load a component from its graph `source`: LINK → EVAL → pick the component.
 *
 * The link phase compiles the entry and, transitively, every graph record it reaches — each one
 * standalone and memoized by exact source, so a second mount of the same page compiles nothing and an
 * edit to one record invalidates only that record. The eval phase runs a Node-style `require` over the
 * linked set: graph module first (which is what preserves `provides` overrides, #3660), then the app
 * registry, then a named error.
 *
 * Throws (compile error / unresolved import / no component export) — the host catches it and falls back.
 */
export async function loadComponentFromSource(
  source: string,
  resolveGraphSource?: GraphSourceResolver,
  exportName?: string,
  /** The compile step, injected. Defaults to the real esbuild-wasm one; `linkGraphModules` has always
   *  taken a `CompileFn` for the same reason, and opening the same seam here is what lets the DECLINE
   *  paths be unit-tested. They are the whole point of the attestation work and esbuild-wasm is
   *  browser-only ("The wasmURL option only works in the browser"), so without this their only coverage
   *  is the e2e harness — and an emitter that is never reached is exactly the silent failure this
   *  feature exists to end. */
  compile: CompileFn = (src) => compileToCjs(src),
): Promise<ComponentType<Record<string, unknown>>> {
  const { linked: linkedAll, failures } = await linkGraphModules(source, resolveGraphSource, compile);
  for (const f of failures) {
    // A record that will not COMPILE is declined like one whose closure is unsatisfiable — one bad record
    // costs its own surface, not the page. Logged per load and NAMED: the Projects page died on
    // "Build failed with 2 errors" with a 241-member closure and nothing to point at, and finding
    // `graphcomponent` took a log dive. This line is what makes the next one a read instead of a hunt.
    log.warn(
      `graph-loader: declined the graph override for "${f.specifier}" — its source does not compile ` +
        `(${f.error}). Falling back to the platform module.`,
      "graph-loader",
    );
    // ATTEST the refusal (#runtime-attests-what-actually-ran). The warn line above is the only trace
    // this ever had, which is why a record could be inert in production and look exactly like a working
    // one. No srcHash: nothing compiled, so there is no version to claim ran.
    attest({ specifier: f.specifier, outcome: "declined-compile", reason: String(f.error).slice(0, 200) });
  }
  // Decline any override that cannot resolve its own closure, so `require` falls back to the platform
  // module it was shadowing rather than the whole page dying on one unreachable leaf
  // (#an-incomplete-override-falls-back-instead-of-killing-the-page).
  const { linked, declined } = pruneUnsatisfiableOverrides(linkedAll, isAppModule);
  for (const d of declined) {
    // WARN, once per declined override per load: the fallback keeps the app working, and this is the
    // only signal that a harvested module is inert. Silence here would turn a broken migration into a
    // permanent no-op nobody ever sees.
    log.warn(
      `graph-loader: declined the graph override for "${d.specifier}" — its closure needs "${d.missing}", ` +
        `which is neither registered nor a record. Falling back to the platform module.`,
      "graph-loader",
    );
    attest({ specifier: d.specifier, outcome: "declined-closure", reason: `needs ${d.missing}` });
  }
  const exports = evaluateEntry(linked, makeRequire(), (specifier, error) => {
    // A graph module that COMPILED and LINKED but throws while EVALUATING falls back to the registry.
    // The commonest cause is a build-time-only form — `import.meta.glob` is a Vite transform esbuild
    // emits verbatim, so it is "not a function" at runtime. Judged at eval rather than by reading the
    // source, because 19 records contain that call and most WORK: the call sits in a path the page never
    // takes, and a source-level check declined those too and regressed the Planning page.
    log.warn(
      `graph-loader: declined the graph override for "${specifier}" — it compiled but threw while ` +
        `evaluating (${String(error).slice(0, 160)}). Falling back to the platform module.`,
      "graph-loader",
    );
    attest({ specifier, outcome: "declined-eval", reason: String(error).slice(0, 200) });
  });
  // ATTEST THE SURVIVING CLOSURE. `linked` is the exact set of modules that made it through compile,
  // prune and eval — so this is the honest answer to "was this implementation linked into something
  // that ran", which is what an ALGORITHM record gets. Execution counts are deliberately NOT claimed:
  // an impl runs inside someone else's module, and counting calls means instrumenting that module.
  //
  // Attested BEFORE the pickComponent check: the closure linked whether or not the ENTRY turns out to
  // export a component, and attributing an entry's failure to every module it pulled in would be wrong.
  for (const [specifier, mod] of linked) {
    attest({ specifier, outcome: "linked", srcHash: srcHash(mod.source) });
  }
  const comp = pickComponent(exports, exportName);
  if (!comp) {
    throw new Error(
      exportName
        ? `runtime loader: the graph source does not export "${exportName}", and exports more than one component — refusing to guess`
        : "runtime loader: the graph source exports no component (need a default export or an exported function)",
    );
  }
  return comp;
}
