// Preview transport (#528/#530): bundle a UI skeleton (in-memory files) with
// esbuild-wasm and produce the srcdoc for a sandboxed iframe. React/three are kept
// external and resolved in the iframe via an esm.sh import-map (the chosen approach).
//
// The esbuild call is isolated; the path resolution, bootstrap, and srcdoc assembly
// are pure so they're unit-testable without the wasm runtime.

// Type-only import — the esbuild-wasm runtime is dynamically imported in
// ensureEsbuild() so the module's load-time invariant (which fails under jsdom)
// never runs in tests, and the pure helpers below stay importable.
import type * as Esbuild from "esbuild-wasm";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";
import importmapEmbedded from "@data/ui/preview-importmap.json";

/** esm.sh import-map for the externals (pinned; `deps` params keep React deduped) — the pins live in
 *  `@data/ui/preview-importmap.json` (#2419; ONE source, also read by streamingRuntime.ts), a plain
 *  embedded import like its `@data/ui/*` neighbors. */
export const DEFAULT_IMPORTMAP: Record<string, string> = importmapEmbedded;

/** Bare specifiers left external — resolved in the iframe by the import-map (derived from its keys
 *  so the two can never drift). */
export const PREVIEW_EXTERNALS = Object.keys(DEFAULT_IMPORTMAP);

const BOOTSTRAP_ENTRY = "__preview_bootstrap__.jsx";

/** The synthetic entry that mounts the skeleton's screen component into #root. */
export function bootstrapSource(screenEntry: string): string {
  const spec = screenEntry.startsWith(".") ? screenEntry : `./${screenEntry}`;
  return `import { createRoot } from "react-dom/client";\nimport Screen from "${spec}";\ncreateRoot(document.getElementById("root")).render(<Screen />);\n`;
}

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

/** Look up an in-memory file, trying common extensions. Pure. */
export function lookupMem(files: Record<string, string>, path: string): { contents: string; loader: "jsx" | "tsx" } | null {
  for (const ext of ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.jsx"]) {
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

function inMemoryPlugin(files: Record<string, string>): Esbuild.Plugin {
  return {
    name: "preview-mem",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: BOOTSTRAP_ENTRY, namespace: "mem" };
        if (PREVIEW_EXTERNALS.includes(args.path)) return { path: args.path, external: true };
        if (args.path.startsWith(".")) return { path: resolveMemPath(args.importer, args.path), namespace: "mem" };
        return { path: args.path, external: true }; // any other bare import → external (esm.sh)
      });
      build.onLoad({ filter: /.*/, namespace: "mem" }, (args) => {
        const hit = lookupMem(files, args.path);
        if (!hit) return { errors: [{ text: `preview: module not found: ${args.path}` }] };
        return { contents: hit.contents, loader: hit.loader };
      });
    },
  };
}

/**
 * Bundle a UI skeleton into a single ESM module that mounts `screenEntry` into #root.
 * `files` is relpath → source (the .ui-skeleton folder, in memory). React/three stay
 * external. Throws on a build error (caller surfaces it).
 */
export async function bundleSkeleton(files: Record<string, string>, screenEntry: string): Promise<string> {
  const esbuild = await ensureEsbuild();
  const withBootstrap = { ...files, [BOOTSTRAP_ENTRY]: bootstrapSource(screenEntry) };
  const result = await esbuild.build({
    entryPoints: [BOOTSTRAP_ENTRY],
    bundle: true,
    format: "esm",
    write: false,
    jsx: "automatic",
    logLevel: "silent",
    plugins: [inMemoryPlugin(withBootstrap)],
  });
  return result.outputFiles?.[0]?.text ?? "";
}

/**
 * Assemble the sandboxed-iframe srcdoc: import-map for the externals + the bundle as a
 * module, with error/ready signals posted to the parent. Pure.
 */
export function buildPreviewSrcDoc(bundleJs: string, importmap: Record<string, string> = DEFAULT_IMPORTMAP): string {
  return `<!doctype html><html><head><meta charset="utf-8" />
<style>html,body,#root{margin:0;height:100%;background:var(--bg, #0d0d0f);font-family:Inter,system-ui,sans-serif;color:#eee}</style>
<script type="importmap">${JSON.stringify({ imports: importmap })}</script>
</head><body><div id="root"></div>
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
