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
import { collapseSegments } from "@/shared/lib/preview/importPath";
import { PREVIEW_SHIM_NAMESPACE, shimModuleFor, scanStubImports, previewCspMeta } from "@/shared/lib/preview/previewShims";
import { isPlatformModule } from "@/shared/lib/preview/platformModules";

/** The esm.sh import-map for the externals (React et al.), shared with the skeleton preview (#2419). This is
 *  the ONLY set of specifiers fetched from a CDN; every OTHER bare import resolves to a bundled-in local
 *  shim/stub (#3696), never to esm.sh at large. */
export const COMPONENT_IMPORTMAP: Record<string, string> = importmapEmbedded;

/** Bare specifiers resolved in the iframe by the import-map (everything else bare → esm.sh at large). */
export const COMPONENT_EXTERNALS = Object.keys(COMPONENT_IMPORTMAP);

/** The suffixes {@link lookupMem} appends when a bare id names a DIRECTORY rather than a file. Shared
 *  with the importer-kind check below so the two can never disagree about what "index-backed" means. */
const INDEX_SUFFIXES = ["/index.tsx", "/index.ts", "/index.jsx"] as const;

/**
 * Resolve a relative import against its importer's directory. Pure.
 *
 * THE IMPORTER MAY BE A DIRECTORY, NOT A FILE (#a-barrel-import-resolves-against-its-own-directory).
 * `lookupMem` accepts a bare id like `shared/ui/kit` by trying `/index.ts`, so a barrel is loaded under
 * the id of its DIRECTORY while its contents come from `<dir>/index.ts`. Stripping the last segment is
 * right for a file (`a/b/c.ts` → `a/b`) and wrong for that id (`shared/ui/kit` → `shared/ui`), which is
 * how the kit barrel's `./theme` resolved to `shared/ui/theme` — a module that does not exist — and took
 * 34 components down with it, every *GraphHost among them.
 *
 * `files` is what tells the two apart: an importer present as a KEY is a file; one reachable only through
 * an index suffix is a directory and is its own `fromDir`. It is optional so existing callers and the
 * pure tests keep the old behaviour, but the esbuild plugin passes it — resolution is only correct when
 * it does.
 */
export function resolveMemPath(importer: string, spec: string, files?: Record<string, string>): string {
  const isDirId =
    !!files &&
    files[importer] == null && // not a file key itself…
    INDEX_SUFFIXES.some((s) => files[importer + s] != null); // …but an index lives under it
  // A directory id is ALREADY the from-dir; a file id drops its basename. `..` then behaves identically
  // in both cases, which is the part a naive "never strip" fix breaks.
  const fromDir = isDirId
    ? importer
    : importer.includes("/")
      ? importer.slice(0, importer.lastIndexOf("/"))
      : "";
  return collapseSegments((fromDir ? fromDir.split("/") : []).concat(spec.split("/")));
}

/**
 * `import.meta.glob` for a preview build (#81, designer request) — the esbuild `define` target and
 * the banner that declares it. Both bundlers use these; neither restates them.
 *
 * `import.meta.glob` is a VITE BUILD MACRO. It is valid production code that Vite expands at build
 * time, and it simply does not exist in an esbuild-wasm build — so at runtime `import.meta.glob` is
 * undefined and calling it throws `(intermediate value).glob is not a function` BEFORE the component
 * function ever executes. Because `agentProfiles.ts` calls it at MODULE TOP LEVEL and `store/index.ts`
 * imports that, every component reaching `useAppStore` inherited the crash: 44 of the store's 49
 * render-errors were this one call. The fully self-contained react-d3 kit, which imports no `@/`
 * modules, has zero.
 *
 * IT RETURNS AN EMPTY OBJECT, deliberately. A preview cannot know what the glob would have matched,
 * so the honest degradation is an empty set — a component renders with no built-in profiles rather
 * than not rendering at all. Stubbing the globbing modules in `platform-modules.json` was the
 * alternative and is worse: hand-authored preview data per module, silently drifting from the real
 * thing, and the code's own comments warn there are siblings (#1715 mirrors data/skills, data/roles).
 *
 * Why a define PLUS a banner rather than just a define: esbuild rejects a function literal as a
 * define value (`Invalid define value (must be an entity name or JS literal)`), so the value has to
 * be an identifier that something else declares.
 */
export const PREVIEW_GLOB_SHIM = "__bscPreviewImportMetaGlob";

/** Declares {@link PREVIEW_GLOB_SHIM} at the top of the bundle, where every module can see it. */
export const PREVIEW_GLOB_BANNER = `var ${PREVIEW_GLOB_SHIM} = () => ({});`;

/** The `define` map that routes `import.meta.glob(…)` to the shim. */
export const PREVIEW_DEFINE: Record<string, string> = { "import.meta.glob": PREVIEW_GLOB_SHIM };

/** The namespace a `?raw` / `?url` import is loaded in — see {@link rawImportSpec}. */
export const PREVIEW_RAW_NAMESPACE = "bsc-raw";

/**
 * Split Vite's `?raw` / `?url` resource query off `spec`, or `null` when it carries neither.
 *
 * THE SECOND VITE-ONLY IMPORT FEATURE (designer request #85), and the same class of gap as
 * `import.meta.glob` above: `import md from "@data/fleet/worker-protocol.md?raw"` is valid production
 * code that Vite expands at build time and esbuild has no equivalent for. The suffixed specifier matched
 * no branch of the resolver — not `@/`, not `@bsc/`, not relative, not a curated external — so it fell
 * to the universal stub (#3696) and the module's default export became a Proxy black-hole where the
 * importer's contract promised a STRING. `persona.ts` imports three protocol files that way and
 * `runtimeFault.ts` four shim templates, so a preview reaching either got a Proxy that quietly answers
 * every property access instead of text.
 *
 * `?url` is handled in the same pass because it is the same mechanism with a different payload, and
 * leaving it behind would just re-file this request.
 */
export function rawImportSpec(spec: string): { base: string; query: "raw" | "url" } | null {
  const m = /^(.*)\?(raw|url)$/.exec(spec);
  return m ? { base: m[1], query: m[2] as "raw" | "url" } : null;
}

/**
 * The module a `?raw` / `?url` import resolves to: `text` as the default export, always a STRING.
 *
 * `text` is the file's real contents when the bundle's own filesystem has it, and `""` when it does not
 * — an EMPTY STRING, never a stub. That is the honest degradation and the shape that matters: an
 * importer doing `md.trim()` or `md.split("\n")` gets an empty result rather than a Proxy that answers
 * every access with a callable, or an `undefined` that throws. Same reasoning as the glob shim returning
 * `{}`: a preview cannot know what it did not receive, so it supplies the empty value of the right type.
 */
export function rawModuleSource(text: string): string {
  return `export default ${JSON.stringify(text)};\n`;
}

/** The text a `?raw` / `?url` specifier resolves to, from an in-memory file set. A `?url` yields its own
 *  base specifier (a path string — nothing in the iframe can fetch it, but the TYPE is what callers use);
 *  a `?raw` yields the file's contents, or `""` when `files` does not carry it. */
export function rawModuleText(files: Record<string, string>, spec: string): string {
  const raw = rawImportSpec(spec);
  if (!raw) return "";
  if (raw.query === "url") return raw.base;
  // `@/…` is the mem filesystem's own key space; anything else (`@data/…`, a relative path) is tried
  // verbatim, so a vendored file is found wherever the caller keyed it.
  const hit = lookupMem(files, raw.base.startsWith("@/") ? raw.base.slice(2) : raw.base) ?? lookupMem(files, raw.base);
  return hit?.contents ?? "";
}

/** The namespace a `@data/…json` import is loaded in — see {@link dataJsonModule}. */
export const PREVIEW_DATA_NAMESPACE = "bsc-data";

/**
 * The app's packaged `@data/**` JSON, embedded so a preview can resolve it (designer request #105).
 *
 * ## The gap
 *
 * `@data/…` matched no branch of the resolver — not `@/`, not `@bsc/`, not relative, not a curated
 * external — so it fell to the universal stub (#3696) and a JSON module's default export became a
 * Proxy. `models.ts` does `import modelsEmbedded from "@data/console/models.json"` and then
 * `MODELS.map(...)`; against a Proxy, `MODEL_IDS` is undefined and every `.find()` on it throws. That
 * is `PaneAt`, `PaneMenu` and `PaneShell`, all with the same `MODEL_IDS.find` TypeError.
 *
 * Exactly the shape #85 fixed for `?raw`/`?url`: a Vite-only import feature esbuild has no equivalent
 * for. There the answer was "the empty value of the right type"; for JSON we can do better and supply
 * the REAL file, which is what a design tool should show. The session that filed this explicitly
 * declined to fabricate a stand-in model catalogue, and was right to.
 *
 * ## Why these two directories are excluded
 *
 * Vendoring every imported `@data` JSON would be 8.88 MB, and 8.7 MB of that is two files:
 * `components/react-ui.json` (4.80 MB) and `knowledge/algorithms.json` (3.91 MB). Excluding them
 * leaves ~171 KB.
 *
 * `components/react-ui.json` is genuinely safe to exclude: nothing imports it as a static ES module —
 * the kit artifact is threaded into the bundler as `source`/`runtime` params instead — so the only
 * record that names it is `componentpreviewframe`, the preview HOST, which is not a thing previewed
 * inside a preview.
 *
 * `knowledge/algorithms.json` is NOT the same case, and excluding it on the same assumption was
 * request #106: `features/algorithms/lib/knowledge.ts` does `import RAW from
 * "@data/knowledge/algorithms.json"` at MODULE TOP LEVEL and `store/index.ts` composes the algorithms
 * slice, so the import is reachable from `@/store` itself — not just from the Algorithms feature UI.
 * 103 of 138 render-doctor findings (StatusBar, PaneMenu/PaneShell, TeamsInspector, …) were every
 * component that merely calls `useAppStore`, none of them rendering anything algorithm-related.
 * {@link DATA_JSON_EMPTY_DEFAULTS} answers this the same way #79 answered `import.meta.glob` a few
 * lines below and #85 answered `?raw`: the honest degradation is the empty value of the right SHAPE,
 * not a Proxy that throws three frames from the real cause. A component that genuinely renders the
 * Algorithms feature in preview shows an empty knowledge graph rather than the real one — degraded,
 * not broken, and still a fraction of the 3.91 MB this was avoiding vendoring in the first place.
 */
const DATA_JSON: Record<string, unknown> = Object.fromEntries(
  Object.entries(
    import.meta.glob(
      // The exclusions are the reason this is a LIST, and they are load-bearing: without them the app
      // bundle carries 8.88 MB of JSON to serve a preview, 8.7 MB of it these two.
      ["@data/**/*.json", "!@data/components/**", "!@data/knowledge/**"],
      { eager: true, import: "default" },
    ) as Record<string, unknown>,
  ).map(([path, value]) => [normalizeDataKey(path), value]),
);

/** A glob key (an absolute or alias-relative path) as its `@data/…` specifier. */
function normalizeDataKey(path: string): string {
  const at = path.lastIndexOf("/data/");
  return at === -1 ? path : `@data${path.slice(at + "/data".length)}`;
}

/** Is `spec` a packaged-data JSON import? */
export function dataJsonSpec(spec: string): boolean {
  return spec.startsWith("@data/") && spec.endsWith(".json");
}

/**
 * Honest empty-shaped fallbacks for `@data/**` JSON specs deliberately excluded from {@link DATA_JSON}
 * (too large to vendor whole) but imported at MODULE TOP LEVEL by something `@/store` composes — see
 * "Why these two directories are excluded" above (request #106). Keyed by spec so a shape stays paired
 * with the one import site it degrades; each value is exactly what that site's own "defaulted to
 * empty" logic already tolerates (`buildKnowledge` in `knowledge.ts` maps a missing `implementations`
 * to `[]`), so a preview reaching it sees a real, valid, empty document — never a Proxy.
 */
const DATA_JSON_EMPTY_DEFAULTS: Record<string, unknown> = {
  "@data/knowledge/algorithms.json": { implementations: [] },
};

/**
 * The module a `@data/…json` import resolves to — the REAL parsed value as the default export, or an
 * {@link DATA_JSON_EMPTY_DEFAULTS} entry's honest empty shape.
 *
 * A specifier neither carries (an excluded directory with no registered default, or a typo) gets a
 * module that THROWS NAMING ITSELF on first access. That is the whole improvement over the universal
 * stub: a Proxy answers every property and fails somewhere else entirely — `MODEL_IDS.find` three
 * frames away — while this says which specifier was missing, at the moment it is touched.
 */
export function dataJsonModule(spec: string): string {
  if (spec in DATA_JSON) return `export default ${JSON.stringify(DATA_JSON[spec])};\n`;
  if (spec in DATA_JSON_EMPTY_DEFAULTS) return `export default ${JSON.stringify(DATA_JSON_EMPTY_DEFAULTS[spec])};\n`;
  return (
    `const missing = ${JSON.stringify(spec)};\n` +
    "export default new Proxy({}, { get() { throw new Error(" +
    '"preview: " + missing + " is not vendored into this preview (see DATA_JSON in componentBundle)"' +
    "); } });\n"
  );
}

/** The esbuild loaders a preview module can be built with. */
export type MemLoader = "jsx" | "tsx" | "ts";

/**
 * Which esbuild loader builds `contents`, given the key it was found under (#79, designer request).
 *
 * TSX IS NOT A SUPERSET OF TS, which is the assumption this replaces. A generic arrow is valid
 * TypeScript in a `.ts` file and is JSX in a `.tsx` file — the two grammars genuinely conflict, so no
 * single loader parses both. Measured against `deployEnv.ts`'s
 * `const clone = <T>(v: T): T => structuredClone(v)`:
 *
 *     ts    OK
 *     tsx   FAIL  The character ">" is not valid inside a JSX element
 *     jsx   FAIL  Expected ";" but found "P"
 *
 * So a JSX-free TypeScript module reached through a barrel could not be built at all, and previewing
 * any component that transitively imported one failed at BUILD time with a JSX parse error against a
 * file containing no JSX.
 *
 * An explicit extension answers it outright. An EXTENSIONLESS key cannot — app-library modules are
 * keyed by their `provides` specifier, which carries no extension — so the SOURCE decides: `</` and
 * `/>` are unambiguous JSX (a closing tag, a self-closing tag) and appear in neither a generic arrow
 * nor a type annotation. Guessing wrong is a loud parse error, never silent wrong output.
 */
export function loaderFor(key: string, contents: string): MemLoader {
  if (key.endsWith(".jsx") || key.endsWith(".js")) return "jsx";
  if (key.endsWith(".tsx")) return "tsx";
  // A `.ts` key is SNIFFED too, not trusted (#a-record-id-ending-in-ts...). The key is often a RECORD
  // ID rather than a filename, and nothing makes an id agree with the syntax of its `code`:
  // `@/app/lazyWorkspaces` is served by the graph-impl record `lazy-workspaces.ts`, which holds a
  // `WorkspaceFallback` COMPONENT. Loaded as `ts`, its `<Row className=…>` parses as a type assertion
  // and esbuild reports `Expected ">" but found "className"` — a syntax error against source that has
  // none, at a line the reader will stare at and find blameless (designer request #103).
  //
  // Safe because the sniff demands a closing or self-closing TAG. The one thing `.ts` offers that
  // `.tsx` does not is `<T>expr`, which contains neither `</` nor `/>` — so a file using type
  // assertions is never upgraded, and one containing real JSX always is.
  const looksJsx = () => /<\/|\/>/.test(withoutStringsAndComments(contents));
  if (key.endsWith(".ts")) return looksJsx() ? "tsx" : "ts";
  return looksJsx() ? "tsx" : "ts";
}

/**
 * `src` with comments and string/template literals removed — so a JSX sniff reads CODE, not prose.
 *
 * Measured, and it is why the naive sniff was not enough: `graphHealth.ts` is a JSX-free analysis
 * module that nonetheless contains `<Name/>` in a doc comment and `` `(<${c.name}/>)` `` in a template
 * literal — it REPORTS on components, so it talks about JSX in strings. Sniffing the raw text called
 * it tsx and it still failed to build with `The character ">" is not valid inside a JSX element`.
 *
 * A regex literal containing `/>` would still fool this (telling a regex from division needs a real
 * parse), which is accepted: an explicit extension always wins, and the failure mode is a loud parse
 * error rather than wrong output.
 */
function withoutStringsAndComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; } // an escaped quote does not close the literal
        if (src[i] === c) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Look up an in-memory file, trying common TS/JS extensions + index files. Pure. */
export function lookupMem(files: Record<string, string>, path: string): { contents: string; loader: MemLoader } | null {
  for (const ext of ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx"]) {
    const key = path + ext;
    if (files[key] != null) {
      return { contents: files[key], loader: loaderFor(key, files[key]) };
    }
  }
  return null;
}

// esbuild-wasm's `initialize()` is a ONE-SHOT global (it boots a Web Worker + the WASM module, both of
// which live in the persistent node_modules singleton, NOT re-executed by HMR). So the init promise is
// cached on `globalThis`, not just a module-level let: a Vite hot-replace of THIS module resets the
// module-level binding but MUST NOT re-`initialize()` the already-live singleton — that throws
// `Cannot call "initialize" more than once`, and (before this) the rejection got cached, wedging EVERY
// subsequent preview build until a full reload (#3190). The `globalThis` cache survives HMR; the catch is
// the belt-and-suspenders so an already-initialized throw resolves to the live module instead of sticking.
const ESBUILD_INIT = Symbol.for("bsc.esbuildInit");
type EsbuildInitHost = { [ESBUILD_INIT]?: Promise<typeof Esbuild> };
export function ensureEsbuild(): Promise<typeof Esbuild> {
  const host = globalThis as unknown as EsbuildInitHost;
  if (!host[ESBUILD_INIT]) {
    host[ESBUILD_INIT] = import("esbuild-wasm").then(async (m) => {
      try {
        await m.initialize({ wasmURL, worker: true });
      } catch (e) {
        // Already booted by a prior module instance (HMR) — reuse the live singleton, don't fail the build.
        if (!/more than once/i.test(String((e as Error)?.message ?? e))) throw e;
      }
      return m;
    });
  }
  return host[ESBUILD_INIT];
}

const CSS_NOOP = "css-noop";

/**
 * Does `spec` — a first-party `@/…` — resolve to a bundled-in STUB rather than to the mem filesystem?
 *
 * True only when it is a REGISTERED platform module (`@data/ui/platform-modules.json`) that `files` does
 * not vendor: the second half of the declared boundary (#3897). The closure runner supplies these by
 * ALIASING each one to the app's real file; a preview iframe is a separate realm with no source to alias,
 * so it supplies a stub instead — the same treatment every non-curated bare specifier already gets (#3696).
 *
 * Vendored is checked FIRST so real source always wins over a stub (many kit components sit at a
 * registered `@/…` position and are handed in with the artifact). An UNregistered `@/…` is never stubbed —
 * a missing sibling stays the honest "module not found" the doctor reports as `no-implementation`.
 *
 * Pure, and exported so the resolution decision is unit-testable without esbuild (which cannot run under
 * jsdom); that the stub then BUILDS and RENDERS is covered in real Chromium by `e2e/previewShims.spec.ts`.
 */
export function stubsBoundaryModule(files: Record<string, string>, spec: string): boolean {
  if (!spec.startsWith("@/")) return false;
  return !lookupMem(files, spec.slice(2)) && isPlatformModule(spec);
}

function componentPlugin(files: Record<string, string>, entry: string): Esbuild.Plugin {
  const isBoundaryStub = (spec: string) => stubsBoundaryModule(files, spec);
  // The named bindings each universal-stubbed package is imported with — so a generated stub exports exactly
  // those (#3696). Scanned once from the component's own files (the dedicated shims have static exports).
  const stubExports = scanStubImports(files, (s) => COMPONENT_EXTERNALS.includes(s), isBoundaryStub);
  return {
    name: "component-preview",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: entry, namespace: "mem" };
        // A Vite `?raw` / `?url` suffix (#85) BEFORE every other branch — the query makes the specifier
        // match none of them, so without this it fell through to the universal stub and the importer got
        // a Proxy where its contract promised a string.
        if (rawImportSpec(args.path)) return { path: args.path, namespace: PREVIEW_RAW_NAMESPACE };
        // `.css` (+ style assets) → an empty module; the app's real styles are injected into the iframe.
        if (/\.(css|scss|sass|less)$/.test(args.path)) return { path: CSS_NOOP, namespace: "empty" };
        // First-party `@/…` → the source file handed in. A registered PLATFORM MODULE (#3897) the files
        // do not vendor is the second half of the declared boundary: the closure runner aliases it to the
        // app's real file, but a preview iframe is a separate realm with no source to alias — so its half
        // is a local stub, the same treatment every non-curated bare specifier already gets (#3696).
        // Vendored wins over the stub (a kit component is real source, not a stub), and an UNregistered
        // `@/…` stays in mem, where a miss is the honest "module not found" a missing sibling should be.
        if (args.path.startsWith("@/")) {
          const mem = args.path.slice(2);
          if (isBoundaryStub(args.path)) return { path: args.path, namespace: PREVIEW_SHIM_NAMESPACE };
          return { path: mem, namespace: "mem" };
        }
        // `@bsc/…` LIBRARY reference (#3116) → its VENDORED module in `files` (an algorithm's real code,
        // keyed by the literal specifier + `.ts`; `componentPreviewFiles` put it there). Resolved like a
        // first-party import — kept in the mem filesystem, NOT external — so the preview runs the library
        // impl. A `@bsc/…` NOT vendored (an unresolvable reference) falls through to the mem loader's
        // "module not found" — the honest build failure graphHealth flags as unresolvable-import.
        if (args.path.startsWith("@bsc/")) return { path: args.path, namespace: "mem" };
        // `@data/…json` (#105) — the app's PACKAGED data, resolved to the real file rather than the
        // universal stub. Before this branch a JSON import became a Proxy and its consumer failed
        // somewhere else entirely; see `DATA_JSON`.
        if (dataJsonSpec(args.path)) return { path: args.path, namespace: PREVIEW_DATA_NAMESPACE };
        // Relative → resolve against the importer within the mem filesystem.
        if (args.path.startsWith(".")) return { path: resolveMemPath(args.importer, args.path, files), namespace: "mem" };
        // Any other bare specifier: a curated external (React et al.) stays external — resolved in the iframe
        // by the import-map (esm.sh). EVERYTHING ELSE resolves to a bundled-in LOCAL shim/stub (#3696), NEVER
        // esm.sh at large — so resolution can't fail (dynamic + always works) and no uncurated CDN code runs
        // (supply-chain safe). react-native → real layout, react-native-svg → real SVG, else the universal stub.
        if (COMPONENT_EXTERNALS.includes(args.path)) return { path: args.path, external: true };
        return { path: args.path, namespace: PREVIEW_SHIM_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: PREVIEW_SHIM_NAMESPACE }, (args) => ({ contents: shimModuleFor(args.path, stubExports.get(args.path)), loader: "js" }));
      build.onLoad({ filter: /.*/, namespace: PREVIEW_RAW_NAMESPACE }, (args) => ({ contents: rawModuleSource(rawModuleText(files, args.path)), loader: "js" }));
      build.onLoad({ filter: /.*/, namespace: PREVIEW_DATA_NAMESPACE }, (args) => ({ contents: dataJsonModule(args.path), loader: "js" }));
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
    // #81 — `import.meta.glob` is a Vite macro with no esbuild equivalent; without this every module
    // that calls it throws at import time and takes every component importing it down with it.
    define: PREVIEW_DEFINE,
    banner: { js: PREVIEW_GLOB_BANNER },
    plugins: [componentPlugin(files, entry)],
  });
  return result.outputFiles?.[0]?.text ?? "";
}

export interface ComponentSrcDocOptions {
  /** CSS injected into the iframe `<style>` — the app's tokens + component styles, so built-ins render
   *  themed (their `.css` imports were no-op'd during bundling). Also the previewed component's
   *  authored-animation CSS (#2870), so its `@keyframes` are present. */
  injectedCss?: string;
  /** The selected theme's `:root` token overrides (#3556), in a DEDICATED `<style id="__bsc_theme">`
   *  separate from `injectedCss` — so a theme change can be applied LIVE via a `{ __bsc_theme }` message
   *  (data-theme + this style's text) without rebuilding the iframe and resetting the pan/zoom engine. */
  themeCss?: string;
  /** The theme attribute set on the iframe root (`data-theme`), so token overrides apply. */
  theme?: "dark" | "light";
  importmap?: Record<string, string>;
  /** Class(es) applied to the `#root` wrapper (#2870) — the previewed component's authored animation
   *  classes (`<component>-anim-<name>`), so its motion actually plays (the keyframes ride in via
   *  `injectedCss`). Sanitised by the caller. Empty ⇒ no class. */
  rootClass?: string;
  /** Selectors of `exit`-triggered animations bound by the previewed component (#3057). When non-empty,
   *  a self-contained exit-runtime shim is injected: a MutationObserver watches `#root`, and when React
   *  unmounts a subtree that matches one of these selectors it re-homes the leaving element, flips the
   *  `[data-bsc-exit]` marker the dormant exit rule keys on (so the exit animation plays), then removes
   *  the element after it finishes. Empty/absent ⇒ NO shim is injected (zero change to the srcdoc). Each
   *  selector is already `SAFE_SELECTOR`-validated at write time and used only in `querySelectorAll`/
   *  `matches`; it is JSON-embedded here regardless. */
  exitSelectors?: string[];
  /** Scale-to-fit the mounted component when it overflows the frame (#3141). For an intrinsic-size
   *  component (a d3 chart with a fixed height, a tall card) that would otherwise clip at the bottom or
   *  bleed past the frame, a shim measures the mount wrapper's natural (pre-transform) size against
   *  `#root` and, when it overflows, `transform: scale(k)`s the wrapper so the WHOLE component shows.
   *  Content that already fits measures k=1 and is untouched. Set for non-page mounts only — pages are
   *  scaled parent-side (#3139), so leave this off for them to avoid double-scaling. Absent ⇒ no shim
   *  (byte-for-byte unchanged srcdoc). */
  fitContent?: boolean;
  /** Render the component at NATURAL size and let tall content SCROLL vertically instead of scaling it to
   *  fit (#3190). The expanded try-on wants real size + scroll (a form/table taller than the frame is
   *  reachable by scrolling, not squished); the fit-shim (`fitContent`) is for the small thumbnails. When
   *  set: the fit-shim is suppressed and the flex-centered mount wrapper is overridden to a growing block
   *  (`display:block; height:auto; min-height:100%`) so content flows top-to-bottom and `#root` (already
   *  `overflow:auto`) scrolls. The wheel then scrolls it (the gesture shim leaves a scrollable region
   *  alone). Mutually exclusive with `fitContent`. Absent ⇒ no override (byte-for-byte unchanged srcdoc). */
  scrollY?: boolean;
  /** Run a self-contained pan/zoom ENGINE inside the iframe (#3190 crisp pass). The zoom is a DOM
   *  transform on the mounted content (`#root`), which the browser re-rasterizes SHARPLY at any scale —
   *  unlike CSS-scaling the iframe element (a composited texture that upsamples → blur). The engine owns
   *  drag-pan + wheel-zoom-about-cursor (leaving real controls + scroll regions alone) and obeys host
   *  `{__cmd:"zoomIn"|"zoomOut"|"fit"}` messages for the +/−/fit buttons. `initial` is a centered zoom
   *  applied on load. Absent ⇒ no engine.
   *
   *  This SUPERSEDED the gesture-forward shim (host-side pan/zoom via postMessage), which a981b8b8
   *  disconnected and #3251 removed: forwarding existed to drive a host CSS scale, and that is exactly
   *  what blurs. The iframe owns the viewport now, so there is nothing to forward. */
  zoomEngine?: { initial?: number; min?: number; max?: number };
  /** Enable the Alt-hold INSPECT layer (#3596) with this list of navigable child component NAMES (the
   *  previewed component's `composes`). While Alt is held the preview rings the child under the cursor and
   *  posts `{__navigate: name}` on click; releasing Alt returns full interactivity. Only the EXPANDED
   *  preview passes it — empty/absent ⇒ no inspect layer (byte-for-byte unchanged srcdoc). */
  inspect?: string[];
}

/**
 * The exit-runtime shim (#3057) — a self-contained, non-module `<script>` that plays kit `exit`
 * animations in the preview iframe. Returns "" when there are no exit selectors (so a non-exit srcdoc is
 * byte-for-byte unchanged). Runs BEFORE React mounts, so the observer is already watching when React
 * later unmounts a conditional subtree.
 *
 * How it works, and the guards that keep it safe:
 * - **Reduced-motion bypass:** if the viewer asks for reduced motion it does nothing — React removes
 *   normally (mirrors the `@media (prefers-reduced-motion: no-preference)` guard on the compiled rule).
 * - **Loop guard (`exiting` WeakSet):** a re-homed leaving node is added to the set BEFORE re-insertion,
 *   so the observer ignores both its re-insertion and its eventual `.remove()` — no infinite loop.
 * - **Position reconstruction:** the node is put back under its old parent (`record.target`, skipped if
 *   detached) before its old next-sibling (`record.nextSibling` when still connected, else appended).
 * - **Cleanup:** each matched element gets `[data-bsc-exit]` (→ the dormant rule now matches → it plays)
 *   and a one-shot `animationend` listener; when all have ended the node is removed, with a 1200ms
 *   `setTimeout` BACKSTOP so a missing `animationend` never leaks the orphaned node.
 *
 * Vanilla ES5-ish (no imports/JSX/template features) — it runs inline in the sandboxed iframe. Only the
 * selector list is interpolated (JSON-embedded); everything else is literal. Pure (a string builder).
 */
export function exitShimScript(exitSelectors: string[]): string {
  if (!exitSelectors.length) return "";
  return `\n<script>
(function () {
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  } catch (e) { /* no matchMedia in this environment → proceed and observe */ }
  var SELS = ${JSON.stringify(exitSelectors)};
  var exiting = new WeakSet();
  var root = document.getElementById("root");
  if (!root) return;
  function playExit(node, matches, parent, before) {
    exiting.add(node);                 // LOOP GUARD: mark before re-inserting so the re-insert + final remove are ignored
    parent.insertBefore(node, before); // put it back exactly where React took it from
    var pending = matches.length;
    var done = false;
    function finish() {
      if (done) return;                // guard-once: animationend AND the backstop both call this
      done = true;
      node.remove();                   // ignored by the observer — node is in \`exiting\`
    }
    function onEnd() {
      pending -= 1;
      if (pending <= 0) finish();
    }
    for (var i = 0; i < matches.length; i++) {
      matches[i].setAttribute("data-bsc-exit", ""); // flip the marker → the dormant exit rule matches → it plays
      matches[i].addEventListener("animationend", onEnd, { once: true });
    }
    setTimeout(finish, 1200);          // BACKSTOP: a missing animationend never leaks the orphaned node
  }
  function cb(records) {
    for (var r = 0; r < records.length; r++) {
      var record = records[r];
      var removed = record.removedNodes;
      for (var n = 0; n < removed.length; n++) {
        var node = removed[n];
        if (!(node instanceof Element) || exiting.has(node)) continue; // Elements only; skip our own re-homed nodes
        var matches = [];
        for (var s = 0; s < SELS.length; s++) {
          try {
            if (node.matches(SELS[s]) && matches.indexOf(node) === -1) matches.push(node);
            var found = node.querySelectorAll(SELS[s]);
            for (var f = 0; f < found.length; f++) if (matches.indexOf(found[f]) === -1) matches.push(found[f]);
          } catch (e) { /* a bad selector never breaks the observer */ }
        }
        if (!matches.length) continue;                 // ordinary unmount — nothing to animate
        var parent = record.target;
        if (!parent || !parent.isConnected) continue;  // parent gone → can't re-home, let it go
        var before = (record.nextSibling && record.nextSibling.isConnected) ? record.nextSibling : null;
        playExit(node, matches, parent, before);
      }
    }
  }
  new MutationObserver(cb).observe(root, { childList: true, subtree: true });
})();
</script>`;
}

/**
 * The scale-to-fit shim (#3141) — a self-contained `<script type="module">` that, after mount, scales an
 * oversized component down so the WHOLE thing shows instead of clipping. Returns "" when `fit` is false
 * (so the srcdoc is byte-for-byte unchanged for pages — they're scaled parent-side per #3139, and scaling
 * them here too would double-scale).
 *
 * Why in the iframe (not parent-side like the page canvas): a component has an INTRINSIC size (a d3 chart
 * with a fixed height, a tall card). The parent already sizes the iframe to the frame; the component
 * overflows WITHIN it. Only in the iframe can we measure the mounted component's natural size and scale it.
 *
 * How + the guards:
 * - **Measure the component, not the wrapper.** `content` is the component's own root (the child of
 *   bootstrapSource's centered mount wrapper). `offsetWidth/offsetHeight` are LAYOUT (pre-transform)
 *   metrics — a CSS transform never changes them — so re-running is idempotent and needs no reset/flash.
 * - **Scale = min(1, …) with a MARGIN** so a fitted component gets a little breathing room from the frame
 *   edge and a component that already fits (k=1) is untouched. Fluid `width:100%` charts fit horizontally
 *   via flex-shrink, so the height ratio typically binds.
 * - **`#root` overflow → hidden:** we fit by scaling, not scrolling; the transform leaves the layout box
 *   its natural (overflowing) size, so hidden clips the residual rather than showing scrollbars.
 * - **Re-fit on settle:** a `ResizeObserver` on `#root` (frame resize) plus timed passes catch a d3-force
 *   simulation or async data that changes the natural size after first paint. Best-effort; a throw here
 *   never breaks the preview.
 *
 * Vanilla, single-root assumption (measures the first element child — the common component shape). Pure.
 */
export function fitShimScript(fit: boolean): string {
  if (!fit) return "";
  return `\n<script type="module">
(function () {
  try {
    var root = document.getElementById("root");
    if (!root) return;
    var wrap = root.firstElementChild;                 // bootstrapSource's centered mount wrapper
    if (!(wrap instanceof HTMLElement)) return;
    var content = wrap.firstElementChild;              // the component's own root element
    if (!(content instanceof HTMLElement)) return;
    root.style.overflow = "hidden";                    // fit by scaling, not scrolling — clip any residual
    var MARGIN = 0.94;                                 // a little breathing room from the frame edge
    function fit() {
      var vw = root.clientWidth, vh = root.clientHeight;
      var cw = content.offsetWidth, ch = content.offsetHeight;  // natural (pre-transform) — transform never changes offset*
      if (!vw || !vh || !cw || !ch) return;
      var k = Math.min(1, (vw * MARGIN) / cw, (vh * MARGIN) / ch);
      content.style.transformOrigin = "center center";
      content.style.transform = k < 1 ? "scale(" + k + ")" : "none";
    }
    try { new ResizeObserver(fit).observe(root); } catch (e) { /* no ResizeObserver → timed passes below */ }
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fit);
    setTimeout(fit, 120);
    setTimeout(fit, 500);                              // re-fit after a d3-force sim / async data settles
  } catch (e) { /* fitting is best-effort — never break the preview */ }
})();
</script>`;
}

/**
 * The pan/zoom ENGINE (#3190 crisp pass) — a self-contained `<script>` that pans + zooms the mounted
 * content by transforming `#root` (a DOM transform → the browser re-rasterizes SHARPLY at any scale,
 * unlike CSS-scaling the iframe element, a composited texture that blurs). All coordinates are
 * iframe-local (clientX/clientY), so there's no host↔iframe coordinate conversion. It:
 *   • pans on a left-drag past a 5px threshold — ANYWHERE, even over a button (a press-without-move
 *     stays a click; a form field keeps its native drag);
 *   • zooms about the cursor on ⌘/ctrl + wheel; a plain wheel pans (a scroll region scrolls itself);
 *   • obeys host `{__cmd:"zoomIn"|"zoomOut"|"fit"}` messages (the +/−/fit buttons — zoom about center /
 *     reset to identity);
 *   • applies a centered `initial` zoom on load;
 *   • cancels the native text-selection + image/link drag that would otherwise fight the pan (#3251 —
 *     the guard must live HERE, in the iframe, since the host's CSS cannot cross the document boundary).
 * Returns "" when off. Vanilla, capture-phase. `#root` gets `transform-origin: 0 0`; the iframe clips
 * the overflow.
 */
export function gestureEngineScript(cfg: { initial?: number; min?: number; max?: number } | undefined): string {
  if (!cfg) return "";
  const min = cfg.min ?? 0.2;
  const max = cfg.max ?? 8;
  return `\n<script>
(function () {
  var MIN = ${min}, MAX = ${max};
  // A press on a form field keeps its NATIVE drag (text selection / caret); everything else drag-pans.
  var DRAG_NATIVE = 'input,textarea,select,[contenteditable]';
  function dragNative(el) {
    for (var n = el; n && n !== document.documentElement && n !== document.body; n = n.parentElement) {
      if (n.nodeType === 1 && n.matches && n.matches(DRAG_NATIVE)) return true;
    }
    return false;
  }
  var view = { tx: 0, ty: 0, scale: 1 };
  var target = null;
  function tgt() { if (!target) target = document.getElementById("root"); return target; }
  function apply() { var t = tgt(); if (t) { t.style.transformOrigin = "0 0"; t.style.transform = "translate(" + view.tx + "px," + view.ty + "px) scale(" + view.scale + ")"; } }
  function clampS(s) { return Math.min(MAX, Math.max(MIN, s)); }
  function zoomAt(factor, px, py) {
    var ns = clampS(view.scale * factor);
    if (ns === view.scale) return;
    var wx = (px - view.tx) / view.scale, wy = (py - view.ty) / view.scale;   // content point under (px,py)
    view.tx = px - wx * ns; view.ty = py - wy * ns; view.scale = ns; apply();  // …held fixed after the zoom
  }
  function centerXY() { return [ (window.innerWidth || document.documentElement.clientWidth || 1) / 2, (window.innerHeight || document.documentElement.clientHeight || 1) / 2 ]; }
  function viewport() { return [ window.innerWidth || document.documentElement.clientWidth || 1, window.innerHeight || document.documentElement.clientHeight || 1 ]; }
  var userTouched = false;   // the moment the user zooms/pans, stop auto-fitting (the open-fit block below)
  // FIT: show the WHOLE component. Measure #root's natural content box, then scale so it fits the viewport —
  // never UPSCALING past 1:1 (crisp) — centered horizontally, TOP-anchored so a tall page's header stays
  // visible and you pan/zoom DOWN. The measurement removes the transform (un-scaled read) AND forces #root to
  // a scroll container: #root normally runs overflow:visible so its overflow renders unclipped, but a
  // visible-overflow element reports scrollHeight === clientHeight (it is not a scroll container), hiding the
  // very overflow we need to fit — so we flip it to overflow:hidden for the read only, then restore. Falls
  // back to identity when unmeasured (jsdom / pre-layout).
  // (NOTE: this text lives INSIDE the engine's template literal — keep it backtick-free, #3551.)
  function fit() {
    var t = tgt();
    var vp = viewport(), cw = vp[0], ch = vp[1], bw = 0, bh = 0;
    if (t) {
      var pt = t.style.transform, po = t.style.overflow;
      t.style.transform = "none"; t.style.overflow = "hidden";
      bw = t.scrollWidth; bh = t.scrollHeight;
      t.style.transform = pt; t.style.overflow = po;
    }
    if (!bw || !bh) { view = { tx: 0, ty: 0, scale: 1 }; apply(); return; }
    var s = Math.min(1, cw / bw, ch / bh);
    view = { scale: s, tx: (cw - bw * s) / 2, ty: 0 };
    apply();
  }
  // DRAG-PAN: a press-and-MOVE (past a small threshold) pans — ANYWHERE, even over a button — so a
  // component that fills the frame is still draggable; a press-WITHOUT-move stays a CLICK (the control
  // keeps it, since a moved drag suppresses the trailing click).
  var pending = false, panning = false, moved = false, sx = 0, sy = 0, lx = 0, ly = 0;
  document.addEventListener("mousedown", function (e) {
    if (e.button !== 0 || e.altKey || dragNative(e.target)) return;   // #3596: Alt-held is INSPECT, not pan
    pending = true; moved = false; sx = lx = e.clientX; sy = ly = e.clientY;
  }, true);
  document.addEventListener("mousemove", function (e) {
    if (!pending) return;
    if (!panning) {
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 5) return;   // below the drag threshold → not a pan yet
      panning = true; userTouched = true; document.body.style.cursor = "grabbing";
    }
    moved = true; e.preventDefault();
    view.tx += e.clientX - lx; view.ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; apply();
  }, true);
  function endPan() { pending = false; panning = false; document.body.style.cursor = ""; }
  document.addEventListener("mouseup", endPan, true);
  window.addEventListener("blur", endPan);
  // #3251: an <img>/<a> press starts a NATIVE drag, which cancels the mousemove stream — the pan would
  // die mid-gesture. Cancel it (form fields keep theirs, matching DRAG_NATIVE).
  document.addEventListener("dragstart", function (e) { if (!dragNative(e.target)) e.preventDefault(); }, true);
  document.addEventListener("click", function (e) { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);
  // WHEEL = ZOOM about the cursor. The try-on is a zoomable design canvas, not a document: scrolling zooms
  // in/out (any wheel/trackpad delta), and CLICK-DRAG is what moves across the screen (the pan above).
  document.addEventListener("wheel", function (e) {
    e.preventDefault(); userTouched = true;
    zoomAt(Math.exp(-e.deltaY * 0.0016), e.clientX, e.clientY);
  }, { capture: true, passive: false });
  window.addEventListener("message", function (e) {
    var d = e.data; if (!d) return;
    // #3437 (bsc debug frames): the host cannot READ this document (opaque origin - sandbox with no
    // allow-same-origin), so the engine describes ITSELF on request. Read-only, and the ONLY way to tell
    // "the script is present but never ran" from "it ran and is listening" without weakening the sandbox.
    if (d.__probe) {
      var root0 = document.getElementById("root");
      try {
        (e.source || parent).postMessage({ __probeReply: {
          listening: true,
          transform: root0 ? getComputedStyle(root0).transform : "none",
          scale: view.scale, pan: [view.tx, view.ty],
        } }, "*");
      } catch (_) { /* a probe must never break the preview */ }
      return;
    }
    if (typeof d.__cmd !== "string") return;
    var c = centerXY();
    if (d.__cmd === "zoomIn") { userTouched = true; zoomAt(1.2, c[0], c[1]); }
    else if (d.__cmd === "zoomOut") { userTouched = true; zoomAt(1 / 1.2, c[0], c[1]); }
    else if (d.__cmd === "fit") fit();
  });
  // Open showing the WHOLE component — ROBUSTLY. The component mounts via a DEFERRED module script that runs
  // AFTER this classic script, so an immediate fit measures an EMPTY #root; and late layout (fonts, images, a
  // data-driven chart) resizes it again. So re-fit until the user first zooms/pans: now, next frame, once the
  // DOM has parsed (the module has mounted), on window load (images), and on any later content resize.
  function refit() { if (!userTouched) fit(); }
  refit();
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(refit);
  window.addEventListener("load", refit);
  function watchContent() {
    refit();
    var child = tgt() && tgt().firstElementChild;   // observe the MOUNTED content (not #root, whose box is fixed)
    if (child && typeof ResizeObserver === "function") {
      try { new ResizeObserver(function () { if (!userTouched) fit(); }).observe(child); } catch (_) { /* best-effort */ }
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchContent);
  else watchContent();
})();
</script>`;
}

/**
 * Assemble the sandboxed-iframe srcdoc: import-map for the externals + the injected app CSS + the bundle
 * as a module, posting `ready`/`error` to the parent. Pure.
 */
/**
 * The Alt-hold INSPECT layer (#3596) — a self-contained `<script>` that, WHILE Alt is held, rings the
 * child component under the cursor and navigates the graph to it on click; releasing Alt returns the
 * preview to full interactivity. A momentary hold modifier, not a mode.
 *
 * It needs no DOM tagging: the preview bundle is UNMINIFIED (see {@link bundleComponent} — no `minify`),
 * so a React fiber's `type.name` is the real component name. From `elementFromPoint` it reads the
 * element's fiber and walks `.return` up to the nearest component whose name is in `navSet` (the
 * previewed component's `composes`) — exactly how React DevTools' element picker works. On Alt-click it
 * `preventDefault`/`stopPropagation`s at document-capture (BEFORE React's root-delegated handler, so the
 * component's own onClick never fires) and posts `{__navigate: name}` to the host.
 *
 * Only the EXPANDED preview passes `components` (its `composes`); the small inspector thumbnail gets ""
 * (byte-for-byte unchanged srcdoc). Vanilla, backtick-free (it lives in the outer template literal,
 * #3551). Pans are suppressed while Alt is held by the gesture engine's own `e.altKey` bail.
 */
export function inspectEngineScript(components: string[]): string {
  if (!components.length) return "";
  return `\n<script>
(function () {
  var NAV = ${JSON.stringify(components)};
  var navSet = {};
  for (var i = 0; i < NAV.length; i++) navSet[NAV[i]] = true;
  var alt = false, box = null, label = null;
  // React 18 stashes a DOM node's fiber as an own '__reactFiber$<hash>' key (present in prod too).
  function fiberOf(node) {
    var ks = Object.keys(node);
    for (var i = 0; i < ks.length; i++) {
      if (ks[i].indexOf("__reactFiber$") === 0 || ks[i].indexOf("__reactInternalInstance$") === 0) return node[ks[i]];
    }
    return null;
  }
  // The first HOST (real DOM) node under a component fiber — its on-screen box for the highlight.
  function hostEl(fiber, fallback) {
    for (var f = fiber; f; f = f.child) { if (f.stateNode && f.stateNode.nodeType === 1) return f.stateNode; }
    return fallback;
  }
  // The nearest composed-child component under (x,y): { name, el } or null. Primary path is the React
  // fiber-walk (the real app); the DATA-ATTR fallback ('data-bsc-comp') keeps it working when fibers are
  // absent (a non-React or minified render) and is the seam the headless e2e harness drives.
  function pick(x, y) {
    // Our own highlight overlay must never intercept the hit-test — hide it across elementFromPoint even
    // though it is pointer-events:none, since the app CSS injected into the iframe can override that.
    if (box) box.style.display = "none";
    if (label) label.style.display = "none";
    var el = document.elementFromPoint(x, y);
    if (box) box.style.display = "";
    if (label) label.style.display = "";
    if (!el) return null;
    for (var fiber = fiberOf(el); fiber; fiber = fiber.return) {
      var t = fiber.type;
      if (typeof t === "function" && t.name && navSet[t.name]) return { name: t.name, el: hostEl(fiber, el) };
    }
    var m = el.closest ? el.closest("[data-bsc-comp]") : null;
    if (m) { var n = m.getAttribute("data-bsc-comp"); if (navSet[n]) return { name: n, el: m }; }
    return null;
  }
  function overlay() {
    if (box) return;
    box = document.createElement("div");
    box.setAttribute("style", "position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid var(--accent,#6ea);border-radius:4px;background:color-mix(in oklch, var(--accent,#6ea) 12%, transparent);");
    label = document.createElement("div");
    label.setAttribute("style", "position:fixed;pointer-events:none;z-index:2147483647;font:600 10px/1.5 var(--mono,ui-monospace,monospace);color:#0b0f14;background:var(--accent,#6ea);padding:1px 6px;border-radius:4px;white-space:nowrap;");
    document.body.appendChild(box); document.body.appendChild(label);
  }
  function clear() { if (box) { box.remove(); label.remove(); box = label = null; } }
  function draw(hit) {
    if (!hit || !hit.el) { clear(); return; }
    overlay();
    var r = hit.el.getBoundingClientRect();
    box.style.left = r.left + "px"; box.style.top = r.top + "px"; box.style.width = r.width + "px"; box.style.height = r.height + "px";
    label.textContent = hit.name;
    label.style.left = r.left + "px"; label.style.top = Math.max(0, r.top - 17) + "px";
  }
  var downAlt = false;
  function setAlt(on) { if (on === alt) return; alt = on; document.body.style.cursor = on ? "crosshair" : ""; if (!on) clear(); }
  window.addEventListener("keydown", function (e) { if (e.altKey) setAlt(true); });
  window.addEventListener("keyup", function (e) { setAlt(e.altKey); });
  window.addEventListener("blur", function () { setAlt(false); });
  // The move re-syncs the cursor/overlay from the LIVE modifier (reliable on a move) — releasing Alt then
  // moving clears the ring and lets the next click through. But the generated CLICK event drops the
  // modifier, so gate the navigation on the MODIFIER CAPTURED AT MOUSEDOWN (reliable, fresh per gesture)
  // instead of the click's own altKey.
  document.addEventListener("mousemove", function (e) { setAlt(e.altKey); if (e.altKey) draw(pick(e.clientX, e.clientY)); }, true);
  // Capture the modifier at MOUSEDOWN (a browser drops it from the generated CLICK), so an Alt-press-then-
  // click navigates even though the click event itself no longer reports altKey.
  document.addEventListener("mousedown", function (e) { downAlt = e.altKey; }, true);
  document.addEventListener("click", function (e) {
    if (!downAlt && !e.altKey) { downAlt = false; return; }
    downAlt = false;
    var hit = pick(e.clientX, e.clientY);
    e.preventDefault(); e.stopPropagation();   // suppress the component's own onClick
    if (hit) { try { parent.postMessage({ __navigate: hit.name }, "*"); } catch (_) {} }
  }, true);
})();
</script>`;
}

export function buildComponentSrcDoc(bundleJs: string, opts: ComponentSrcDocOptions = {}): string {
  const { injectedCss = "", themeCss = "", theme = "dark", importmap = COMPONENT_IMPORTMAP, rootClass = "", exitSelectors = [], fitContent = false, scrollY = false, zoomEngine, inspect = [] } = opts;
  // #3057: the exit-runtime shim, injected right after `#root` and BEFORE the module script so the
  // observer is watching before React mounts (and later unmounts) subtrees. "" when no exit selectors —
  // the non-exit srcdoc is then byte-for-byte unchanged.
  const exitShim = exitShimScript(exitSelectors);
  // #3141: the scale-to-fit shim, injected AFTER the module script so it runs post-mount (measures the
  // mounted component). "" for pages (scaled parent-side per #3139) so their srcdoc is unchanged. #3190:
  // suppressed under scrollY — that mode wants natural size + scroll, not scale-to-fit.
  const fitShim = fitShimScript(fitContent && !scrollY && !zoomEngine);
  // #3190: scrollY override — turn the flex-centered mount wrapper into a growing top-anchored block so
  // tall content flows down and `#root` (overflow:auto) scrolls it, instead of centering (which strands
  // the top out of reach) or scaling. `!important` beats the wrapper's inline flex/height.
  const scrollCss = scrollY ? `\n<style>#root>*{display:block!important;height:auto!important;min-height:100%}</style>` : "";
  // #3190 crisp pass: the in-iframe pan/zoom ENGINE — transforms `#root` (crisp DOM) instead of forwarding
  // to a host CSS scale (a blurry iframe texture). Clip cleanly + no scrollbars while it drives the view.
  const engineShim = gestureEngineScript(zoomEngine);
  // #3596: the Alt-hold inspect layer — navigate to a child component under the cursor. "" (unchanged
  // srcdoc) unless the expanded preview passed the `composes` names. Injected after the engine so its
  // capture-phase click handler is in place; the engine's own `e.altKey` bail keeps Alt from panning.
  const inspectShim = inspectEngineScript(inspect);
  // #3251: the engine's drag lives INSIDE the iframe, so the selection guard must too — the host
  // wrapper's `user-select:none` cannot cross a document boundary. Without this, a press-and-move
  // starts a native text selection instead of panning. Form fields keep caret + selection (mirrors the
  // engine's own DRAG_NATIVE list, which already leaves their native drag alone).
  // #3551: the engine FITS the WHOLE component, so nothing may clamp the content to the frame height and
  // clip its overflow — the clip cannot be un-scaled away, so the off-screen part never renders. `html,body`
  // keep `overflow:hidden` (the frame is the viewport — no scrollbars), but `#root` AND the mount wrapper
  // grow to the content (`height:auto`, at least full-frame) and DON'T self-clip (`overflow:visible`), so
  // the component lays out to its full natural height, the engine measures it, and fit scales it all in.
  const engineCss = zoomEngine
    ? `\n<style>html,body{overflow:hidden}#root{overflow:visible}`
      + `#root>*{display:block!important;height:auto!important;min-height:100%;overflow:visible!important}`
      + `body{user-select:none;-webkit-user-select:none}`
      + `input,textarea,select,[contenteditable]{user-select:text;-webkit-user-select:text}</style>`
    : "";
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8" />
${previewCspMeta()}
<style>html,body,#root{margin:0;height:100%;box-sizing:border-box}#root{overflow:auto}*,*::before,*::after{box-sizing:inherit}
/* Fit oversized preview media (d3 charts/graphs, images) within the frame rather than overflowing it (#2915).
   Aspect-preserving on replaced/viewBox elements; the definite height chain above lets max-height:100% resolve.
   Fluid (width:100%) components are unaffected — the caps only bite oversized fixed-dimension media. */
#root svg,#root canvas,#root img,#root video{max-width:100%;max-height:100%}</style>${scrollCss}${engineCss}
<style>${injectedCss}</style>
<style id="__bsc_theme">${themeCss}</style>
<script type="importmap">${JSON.stringify({ imports: importmap })}</script>
</head><body><div id="root"${rootClass ? ` class="${rootClass}"` : ""}></div>${exitShim}
<script>
  // #108: for SOME uncaught throws in here — a native API rejecting the opaque sandbox origin
  // (e.g. \`localStorage\`, \`sessionStorage\`) is the case that sent a designer in blind — the browser
  // hands ErrorEvent.message a near-empty stub ("Uncaught ") while the REAL DOMException/Error, name,
  // message and stack all still ride on ErrorEvent.error. Prefer that when it's there; only a script the
  // browser truly treats as cross-origin (message stays sanitized AND error is null) falls back to the
  // bare message.
  function describeError(err) {
    if (err && typeof err === "object") {
      var head = err.name ? (err.name + ": " + (err.message || "")) : String(err.message || err);
      return err.stack ? (head + "\\n" + err.stack) : head;
    }
    return null;
  }
  window.addEventListener("error", (e) => parent.postMessage({ __preview: "error", message: describeError(e.error) || String(e.message) }, "*"));
  window.addEventListener("unhandledrejection", (e) => parent.postMessage({ __preview: "error", message: describeError(e.reason) || String(e.reason) }, "*"));
  // #3556: apply a THEME change live — set the data-theme base + swap the token overrides — WITHOUT a
  // rebuild, so the in-iframe pan/zoom engine (and any other runtime state) survives a theme switch.
  window.addEventListener("message", (e) => {
    const t = e.data && e.data.__bsc_theme; if (!t) return;
    if (typeof t.base === "string") document.documentElement.setAttribute("data-theme", t.base);
    const s = document.getElementById("__bsc_theme"); if (s && typeof t.css === "string") s.textContent = t.css;
  });
</script>
<script type="module">
${bundleJs}
parent.postMessage({ __preview: "ready" }, "*");
// Empty-render probe (#2926): a beat after mount (past sync + effect renders), measure whether #root
// produced anything visible — no element beyond the bootstrap wrapper AND no trimmed text — and report
// it. Cheap + best-effort; the parent probe folds this into its ok verdict. Guarded so a throw here
// never masks a real render error (the error listeners above own that).
setTimeout(() => {
  try {
    var r = document.getElementById("root");
    var empty = !!r && r.querySelectorAll("*").length <= 1 && (r.textContent || "").trim().length === 0;
    parent.postMessage({ __preview: "rendered", empty: empty }, "*");
  } catch (e) { /* measurement is best-effort */ }
}, 400);
</script>${fitShim}${engineShim}${inspectShim}
</body></html>`;
}
