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
import { collapseSegments } from "./importPath";
import { PREVIEW_SHIM_NAMESPACE, shimModuleFor, scanStubImports, previewCspMeta } from "./previewShims";

/** The esm.sh import-map for the externals (React et al.), shared with the skeleton preview (#2419). This is
 *  the ONLY set of specifiers fetched from a CDN; every OTHER bare import resolves to a bundled-in local
 *  shim/stub (#3696), never to esm.sh at large. */
export const COMPONENT_IMPORTMAP: Record<string, string> = importmapEmbedded;

/** Bare specifiers resolved in the iframe by the import-map (everything else bare → esm.sh at large). */
export const COMPONENT_EXTERNALS = Object.keys(COMPONENT_IMPORTMAP);

/** Resolve a relative import against its importer's directory. Pure. */
export function resolveMemPath(importer: string, spec: string): string {
  const fromDir = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : "";
  return collapseSegments((fromDir ? fromDir.split("/") : []).concat(spec.split("/")));
}

/** Look up an in-memory file, trying common TS/JS extensions + index files. Pure. */
export function lookupMem(files: Record<string, string>, path: string): { contents: string; loader: "jsx" | "tsx" } | null {
  for (const ext of ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx"]) {
    const key = path + ext;
    if (files[key] != null) {
      // A component source is TypeScript/TSX. `.tsx`/`.ts` are obviously tsx; an EXTENSIONLESS key
      // (a `src` recorded as a directory, e.g. WorkspaceShellPage's `src/shared/ui/layouts` — #3549)
      // is ALSO a component source, so DEFAULT to tsx and use jsx only for an explicit `.jsx`/`.js`.
      // The tsx loader is a superset (parses TS + JS + JSX), so this can only widen what parses — a
      // TS-only source loaded as `jsx` fails on `import type {…}` with `Expected "from" but found "{"`.
      const loader: "jsx" | "tsx" = key.endsWith(".jsx") || key.endsWith(".js") ? "jsx" : "tsx";
      return { contents: files[key], loader };
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

function componentPlugin(files: Record<string, string>, entry: string): Esbuild.Plugin {
  // The named bindings each universal-stubbed package is imported with — so a generated stub exports exactly
  // those (#3696). Scanned once from the component's own files (the dedicated shims have static exports).
  const stubExports = scanStubImports(files, (s) => COMPONENT_EXTERNALS.includes(s));
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
        // Any other bare specifier: a curated external (React et al.) stays external — resolved in the iframe
        // by the import-map (esm.sh). EVERYTHING ELSE resolves to a bundled-in LOCAL shim/stub (#3696), NEVER
        // esm.sh at large — so resolution can't fail (dynamic + always works) and no uncurated CDN code runs
        // (supply-chain safe). react-native → real layout, react-native-svg → real SVG, else the universal stub.
        if (COMPONENT_EXTERNALS.includes(args.path)) return { path: args.path, external: true };
        return { path: args.path, namespace: PREVIEW_SHIM_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: PREVIEW_SHIM_NAMESPACE }, (args) => ({ contents: shimModuleFor(args.path, stubExports.get(args.path)), loader: "js" }));
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
  window.addEventListener("error", (e) => parent.postMessage({ __preview: "error", message: String(e.message) }, "*"));
  window.addEventListener("unhandledrejection", (e) => parent.postMessage({ __preview: "error", message: String(e.reason) }, "*"));
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
