// componentBundle (#2824) — bundle a single component's in-memory source with esbuild-wasm and produce
// the srcdoc for a sandboxed preview iframe. A sibling of the planner's skeleton bundler
// (`features/planner/preview/previewBundle`): both bundle in-browser with esbuild-wasm and keep React
// external via the SAME esm.sh import-map (`@data/ui/preview-importmap.json`), but a COMPONENT preview
// additionally must (a) resolve the `@/…` first-party imports the built-in kit uses — against the source
// files handed in (the packaged kit artifact's `source` + `runtime`) — and (b) no-op `.css` imports (the
// app's real styles are injected into the iframe instead). Those two needs are why this is separate; the
// pure helpers are unit-tested, the esbuild call is isolated (it can't run under jsdom).
import type * as Esbuild from "esbuild-wasm";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";
import importmapEmbedded from "@data/ui/preview-importmap.json";

/** The esm.sh import-map for the externals (React et al.), shared with the skeleton preview (#2419). */
export const COMPONENT_IMPORTMAP: Record<string, string> = importmapEmbedded;

/** Bare specifiers resolved in the iframe by the import-map (everything else bare → esm.sh at large). */
export const COMPONENT_EXTERNALS = Object.keys(COMPONENT_IMPORTMAP);

/** Resolve a relative import against its importer's directory. Pure. */
export function resolveMemPath(importer: string, spec: string): string {
  const fromDir = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : "";
  const parts = (fromDir ? fromDir.split("/") : []).concat(spec.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/** Look up an in-memory file, trying common TS/JS extensions + index files. Pure. */
export function lookupMem(files: Record<string, string>, path: string): { contents: string; loader: "jsx" | "tsx" } | null {
  for (const ext of ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx"]) {
    const key = path + ext;
    if (files[key] != null) {
      const loader: "jsx" | "tsx" = key.endsWith(".tsx") || key.endsWith(".ts") ? "tsx" : "jsx";
      return { contents: files[key], loader };
    }
  }
  return null;
}

let initPromise: Promise<typeof Esbuild> | null = null;
function ensureEsbuild(): Promise<typeof Esbuild> {
  if (!initPromise) {
    initPromise = import("esbuild-wasm").then(async (m) => {
      await m.initialize({ wasmURL, worker: true });
      return m;
    });
  }
  return initPromise;
}

/** Is a bare (non-relative, non-`@/`) specifier — an npm package left external (→ esm.sh). */
function isBare(spec: string): boolean {
  return !spec.startsWith(".") && !spec.startsWith("@/") && !spec.startsWith("/");
}

const CSS_NOOP = "css-noop";

function componentPlugin(files: Record<string, string>, entry: string): Esbuild.Plugin {
  return {
    name: "component-preview",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: entry, namespace: "mem" };
        // `.css` (+ style assets) → an empty module; the app's real styles are injected into the iframe.
        if (/\.(css|scss|sass|less)$/.test(args.path)) return { path: CSS_NOOP, namespace: "empty" };
        // First-party `@/…` → the source file handed in (built-in kit source/runtime).
        if (args.path.startsWith("@/")) return { path: args.path.slice(2), namespace: "mem" };
        // Relative → resolve against the importer within the mem filesystem.
        if (args.path.startsWith(".")) return { path: resolveMemPath(args.importer, args.path), namespace: "mem" };
        // Anything else bare → external (React via the import-map; any other lib → esm.sh at large).
        if (isBare(args.path)) return { path: args.path, external: true };
        return { path: args.path, external: true };
      });
      build.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
      build.onLoad({ filter: /.*/, namespace: "mem" }, (args) => {
        const hit = lookupMem(files, args.path);
        if (!hit) return { errors: [{ text: `preview: module not found: ${args.path}` }] };
        return { contents: hit.contents, loader: hit.loader };
      });
    },
  };
}

/**
 * Bundle a component preview (`files` = relpath → source, incl. the bootstrap `entry`) into one ESM
 * module. First-party `@/…` resolves to `files`; `.css` is no-op'd; bare packages stay external
 * (esm.sh). Throws on a build error (caller surfaces it).
 */
export async function bundleComponent(files: Record<string, string>, entry: string): Promise<string> {
  const esbuild = await ensureEsbuild();
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    write: false,
    jsx: "automatic",
    logLevel: "silent",
    plugins: [componentPlugin(files, entry)],
  });
  return result.outputFiles?.[0]?.text ?? "";
}

export interface ComponentSrcDocOptions {
  /** CSS injected into the iframe `<style>` — the app's tokens + component styles, so built-ins render
   *  themed (their `.css` imports were no-op'd during bundling). Also the previewed component's
   *  authored-animation CSS (#2870), so its `@keyframes` are present. */
  injectedCss?: string;
  /** The theme attribute set on the iframe root (`data-theme`), so token overrides apply. */
  theme?: "dark" | "light";
  importmap?: Record<string, string>;
  /** Class(es) applied to the `#root` wrapper (#2870) — the previewed component's authored animation
   *  classes (`<component>-anim-<name>`), so its motion actually plays (the keyframes ride in via
   *  `injectedCss`). Sanitised by the caller. Empty ⇒ no class. */
  rootClass?: string;
}

/**
 * Assemble the sandboxed-iframe srcdoc: import-map for the externals + the injected app CSS + the bundle
 * as a module, posting `ready`/`error` to the parent. Pure.
 */
export function buildComponentSrcDoc(bundleJs: string, opts: ComponentSrcDocOptions = {}): string {
  const { injectedCss = "", theme = "dark", importmap = COMPONENT_IMPORTMAP, rootClass = "" } = opts;
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8" />
<style>html,body,#root{margin:0;height:100%;box-sizing:border-box}#root{overflow:auto}*,*::before,*::after{box-sizing:inherit}
/* Fit oversized preview media (d3 charts/graphs, images) within the frame rather than overflowing it (#2915).
   Aspect-preserving on replaced/viewBox elements; the definite height chain above lets max-height:100% resolve.
   Fluid (width:100%) components are unaffected — the caps only bite oversized fixed-dimension media. */
#root svg,#root canvas,#root img,#root video{max-width:100%;max-height:100%}</style>
<style>${injectedCss}</style>
<script type="importmap">${JSON.stringify({ imports: importmap })}</script>
</head><body><div id="root"${rootClass ? ` class="${rootClass}"` : ""}></div>
<script>
  window.addEventListener("error", (e) => parent.postMessage({ __preview: "error", message: String(e.message) }, "*"));
  window.addEventListener("unhandledrejection", (e) => parent.postMessage({ __preview: "error", message: String(e.reason) }, "*"));
</script>
<script type="module">
${bundleJs}
parent.postMessage({ __preview: "ready" }, "*");
</script>
</body></html>`;
}
