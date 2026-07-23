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
import { ensureEsbuild } from "@/shared/lib/preview/componentBundle";
import { resolveAppModule, isAppModule, registeredSpecifiers } from "./moduleRegistry";

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

/** The esbuild namespace holding vendored graph-sibling sources (kept out of the filesystem resolver). */
const GRAPH_NS = "graph-sibling";

/**
 * Route ONE non-entry import (pure over the live registry + the injected resolver, so it's unit-testable
 * without esbuild — the real compile is browser-only). Three outcomes:
 *   - `{ external: true }` — a registered PLATFORM module (→ `require()`, resolved via the registry), OR a
 *     bare library / unresolved sibling (→ `require` throws a named error at eval time);
 *   - `{ vendor: source }` — a graph SIBLING the app resolved to source: bundle it in, recursively.
 */
export function routeImport(
  path: string,
  resolveGraphSource?: GraphSourceResolver,
): { external: true } | { vendor: string } {
  if (isAppModule(path)) return { external: true };
  const source = resolveGraphSource?.(path);
  return source != null ? { vendor: source } : { external: true };
}

/** esbuild plugin applying [`routeImport`]: platform + libraries stay external (→ registry `require`),
 *  graph siblings are vendored into this build. Without a resolver it degrades to "everything external" —
 *  the single-component behaviour of #3605. */
function loaderPlugin(resolveGraphSource?: GraphSourceResolver): Esbuild.Plugin {
  return {
    name: "runtime-loader",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return undefined;
        const route = routeImport(args.path, resolveGraphSource);
        return "vendor" in route
          ? { path: args.path, namespace: GRAPH_NS, pluginData: { source: route.vendor } }
          : { path: args.path, external: true };
      });
      build.onLoad({ filter: /.*/, namespace: GRAPH_NS }, (args) => ({
        contents: (args.pluginData as { source: string }).source,
        loader: "tsx",
      }));
    },
  };
}

/**
 * Compile graph `source` (a self-standing module string) to CommonJS. Exported for tests + the loader.
 * `jsx: "automatic"` emits `require("react/jsx-runtime")`, so that MUST be a registered platform module.
 * `resolveGraphSource` (optional) vendors sibling graph components into the same build (#3606).
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
    plugins: [loaderPlugin(resolveGraphSource)],
  });
  return result.outputFiles?.[0]?.text ?? "";
}

/** The `require` a loaded module runs against — the registry, with a loud error for an unresolved specifier
 *  so a missing platform registration is a named failure, not a silent `undefined` that throws deep in React. */
export function makeRequire(): (specifier: string) => unknown {
  return (specifier: string) => {
    if (isAppModule(specifier)) return resolveAppModule(specifier);
    throw new Error(
      `runtime loader: import "${specifier}" is not a registered app module. ` +
        `Register it (registerAppModule) or vendor it as a graph component. Available: ${registeredSpecifiers().join(", ")}`,
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

/** Pick the component export from a loaded module: a `default` export, else the first exported function
 *  (React components are functions). `null` when the module exports no component. */
export function pickComponent(exports: Record<string, unknown>): ComponentType<Record<string, unknown>> | null {
  const cand = exports.default ?? Object.values(exports).find((v) => typeof v === "function");
  return typeof cand === "function" ? (cand as ComponentType<Record<string, unknown>>) : null;
}

/**
 * Load a component from its graph `source`: compile → eval against the live registry → pick the component.
 * `resolveGraphSource` (optional) vendors sibling graph components (#3606) — a page pulls in its panels.
 * Throws (compile error / unresolved import / no component export) — the host catches it. NOT memoized here;
 * the host memoizes per (id, source) so a store edit re-loads.
 */
export async function loadComponentFromSource(
  source: string,
  resolveGraphSource?: GraphSourceResolver,
): Promise<ComponentType<Record<string, unknown>>> {
  const cjs = await compileToCjs(source, resolveGraphSource);
  const exports = evalCjsModule(cjs, makeRequire());
  const comp = pickComponent(exports);
  if (!comp) throw new Error("runtime loader: the graph source exports no component (need a default export or an exported function)");
  return comp;
}
