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
        // `@bsc/…` LIBRARY reference (#3116) → its VENDORED module in `files` (an algorithm's real code,
        // keyed by the literal specifier + `.ts`; `componentPreviewFiles` put it there). Resolved like a
        // first-party import — kept in the mem filesystem, NOT external — so the preview runs the library
        // impl. A `@bsc/…` NOT vendored (an unresolvable reference) falls through to the mem loader's
        // "module not found" — the honest build failure graphHealth flags as unresolvable-import.
        if (args.path.startsWith("@bsc/")) return { path: args.path, namespace: "mem" };
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
 * Assemble the sandboxed-iframe srcdoc: import-map for the externals + the injected app CSS + the bundle
 * as a module, posting `ready`/`error` to the parent. Pure.
 */
export function buildComponentSrcDoc(bundleJs: string, opts: ComponentSrcDocOptions = {}): string {
  const { injectedCss = "", theme = "dark", importmap = COMPONENT_IMPORTMAP, rootClass = "", exitSelectors = [], fitContent = false } = opts;
  // #3057: the exit-runtime shim, injected right after `#root` and BEFORE the module script so the
  // observer is watching before React mounts (and later unmounts) subtrees. "" when no exit selectors —
  // the non-exit srcdoc is then byte-for-byte unchanged.
  const exitShim = exitShimScript(exitSelectors);
  // #3141: the scale-to-fit shim, injected AFTER the module script so it runs post-mount (measures the
  // mounted component). "" for pages (scaled parent-side per #3139) so their srcdoc is unchanged.
  const fitShim = fitShimScript(fitContent);
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8" />
<style>html,body,#root{margin:0;height:100%;box-sizing:border-box}#root{overflow:auto}*,*::before,*::after{box-sizing:inherit}
/* Fit oversized preview media (d3 charts/graphs, images) within the frame rather than overflowing it (#2915).
   Aspect-preserving on replaced/viewBox elements; the definite height chain above lets max-height:100% resolve.
   Fluid (width:100%) components are unaffected — the caps only bite oversized fixed-dimension media. */
#root svg,#root canvas,#root img,#root video{max-width:100%;max-height:100%}</style>
<style>${injectedCss}</style>
<script type="importmap">${JSON.stringify({ imports: importmap })}</script>
</head><body><div id="root"${rootClass ? ` class="${rootClass}"` : ""}></div>${exitShim}
<script>
  window.addEventListener("error", (e) => parent.postMessage({ __preview: "error", message: String(e.message) }, "*"));
  window.addEventListener("unhandledrejection", (e) => parent.postMessage({ __preview: "error", message: String(e.reason) }, "*"));
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
</script>${fitShim}
</body></html>`;
}
