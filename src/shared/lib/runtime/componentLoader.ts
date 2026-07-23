// The runtime component loader (#3605, epic #3604) — compile a component's source FROM THE GRAPH and run
// it in the LIVE app, with its imports wired to the app's real modules ([`moduleRegistry`]).
//
// This is the deliberate OPPOSITE of the preview bundler (`componentBundle.ts`): the preview ISOLATES —
// it stubs React from a CDN and forbids `@/` first-party imports, so a component runs in a sandboxed
// iframe with no access to the real store/hooks. The loader CONNECTS — it keeps every import external and
// resolves it, at run time, to the app's OWN running module, so a loaded page fires real hooks and reads
// live state. That is the whole point: the graph, not the bundler, is the source of the app's UI.
//
// HOW (this slice — single component, no graph siblings yet, #3606 adds those):
//   1. esbuild-wasm transforms the source (JSX → `jsx()` calls) to CommonJS, marking EVERY import
//      external — so each `import … from "x"` becomes `require("x")` in the output.
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

/** esbuild plugin: keep EVERY import external (→ `require()` in the CJS output), so the runtime resolves
 *  them via the registry. Graph-sibling vendoring is added in #3606; this slice loads a single component. */
function loaderPlugin(): Esbuild.Plugin {
  return {
    name: "runtime-loader",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => (args.kind === "entry-point" ? undefined : { path: args.path, external: true }));
    },
  };
}

/**
 * Compile graph `source` (a self-standing module string) to CommonJS. Exported for tests + the loader.
 * `jsx: "automatic"` emits `require("react/jsx-runtime")`, so that MUST be a registered platform module.
 */
export async function compileToCjs(source: string): Promise<string> {
  const esbuild = await ensureEsbuild();
  const result = await esbuild.build({
    stdin: { contents: source, loader: "tsx", sourcefile: "graph-component.tsx" },
    bundle: true,
    format: "cjs",
    write: false,
    jsx: "automatic",
    logLevel: "silent",
    plugins: [loaderPlugin()],
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
  // eslint-disable-next-line no-new-func -- runtime graph-code execution is the feature (#3604); the caller wraps it in an error boundary.
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
 * Throws (compile error / unresolved import / no component export) — the host catches it. NOT memoized here;
 * the host memoizes per (id, source) so a store edit re-loads.
 */
export async function loadComponentFromSource(source: string): Promise<ComponentType<Record<string, unknown>>> {
  const cjs = await compileToCjs(source);
  const exports = evalCjsModule(cjs, makeRequire());
  const comp = pickComponent(exports);
  if (!comp) throw new Error("runtime loader: the graph source exports no component (need a default export or an exported function)");
  return comp;
}
