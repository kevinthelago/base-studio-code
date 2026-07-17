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

// esbuild-wasm's `initialize()` is a ONE-SHOT global (it boots a Web Worker + the WASM module, both of
// which live in the persistent node_modules singleton, NOT re-executed by HMR). So the init promise is
// cached on `globalThis`, not just a module-level let: a Vite hot-replace of THIS module resets the
// module-level binding but MUST NOT re-`initialize()` the already-live singleton — that throws
// `Cannot call "initialize" more than once`, and (before this) the rejection got cached, wedging EVERY
// subsequent preview build until a full reload (#3190). The `globalThis` cache survives HMR; the catch is
// the belt-and-suspenders so an already-initialized throw resolves to the live module instead of sticking.
const ESBUILD_INIT = Symbol.for("bsc.esbuildInit");
type EsbuildInitHost = { [ESBUILD_INIT]?: Promise<typeof Esbuild> };
function ensureEsbuild(): Promise<typeof Esbuild> {
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
  /** Render the component at NATURAL size and let tall content SCROLL vertically instead of scaling it to
   *  fit (#3190). The expanded try-on wants real size + scroll (a form/table taller than the frame is
   *  reachable by scrolling, not squished); the fit-shim (`fitContent`) is for the small thumbnails. When
   *  set: the fit-shim is suppressed and the flex-centered mount wrapper is overridden to a growing block
   *  (`display:block; height:auto; min-height:100%`) so content flows top-to-bottom and `#root` (already
   *  `overflow:auto`) scrolls. The wheel then scrolls it (the gesture shim leaves a scrollable region
   *  alone). Mutually exclusive with `fitContent`. Absent ⇒ no override (byte-for-byte unchanged srcdoc). */
  scrollY?: boolean;
  /** Forward viewport gestures (pan + zoom) from inside the iframe to the parent (#3190). The iframe owns
   *  its DOM, so it decides per event: a non-interactive drag is `postMessage`d as `panstart`/`panmove`/
   *  `panend` (the host pans); a wheel that isn't over a scrollable region is sent as `zoom` (the host
   *  zooms about the cursor). A press on a real control, and a wheel over a scroll container, are left for
   *  the component. Hover + clicks always work. Set only where the host listens (the expanded preview);
   *  absent ⇒ no script (byte-for-byte unchanged srcdoc). */
  forwardGestures?: boolean;
  /** Run a self-contained pan/zoom ENGINE inside the iframe (#3190 crisp pass). The zoom is a DOM
   *  transform on the mounted content (`#root`), which the browser re-rasterizes SHARPLY at any scale —
   *  unlike CSS-scaling the iframe element (a composited texture that upsamples → blur). The engine owns
   *  drag-pan + wheel-zoom-about-cursor (leaving real controls + scroll regions alone) and obeys host
   *  `{__cmd:"zoomIn"|"zoomOut"|"fit"}` messages for the +/−/fit buttons. `initial` is a centered zoom
   *  applied on load. Mutually exclusive with `forwardGestures`. Absent ⇒ no engine. */
  zoomEngine?: { initial?: number; min?: number; max?: number };
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
 * The gesture-forward shim (#3190) — a self-contained `<script>` that lets the iframe DECIDE, per event,
 * whether a gesture belongs to the component or to the host viewport (only the iframe can see its own
 * DOM). It postMessages the surviving gestures out to the parent (which listens without a strict
 * source-window match, since these message shapes are emitted ONLY by this shim):
 *
 * - **Drag-pan.** On a left mousedown whose target is NOT interactive (no control tag / `[role]` /
 *   focusable / `cursor:pointer` / `svg`/`canvas` ancestor), it `preventDefault`s and posts `panstart`,
 *   then `panmove` (absolute screen coords → the host computes pixel deltas) and `panend`. A press on a
 *   real control returns early → the component keeps it.
 * - **Wheel-zoom.** On a wheel that is NOT over a genuinely scrollable ancestor (one whose `overflow-y`
 *   is auto/scroll AND can still scroll further in the wheel's direction), it `preventDefault`s and posts
 *   `zoom` with the deltaY + the cursor as a FRACTION of the iframe viewport (fx,fy ∈ [0,1]). The host
 *   resolves that against the iframe's REAL rendered rect → the true page position → zoom about the cursor
 *   via the SAME path the gutter wheel uses. (Sending a fraction, not iframe-local px, means the anchor
 *   never relies on "iframe px == world coords" — a border/offset/fit can't skew it.) Over a scrollable
 *   region it does nothing → that region scrolls normally.
 *
 * Why `svg`/`canvas` count as interactive for the pan test: an interactive data-viz (d3 force graph,
 * zoomable chart) attaches its drag handlers PROGRAMMATICALLY to its `<svg>`/`<canvas>` and often sets no
 * `cursor:pointer`/role — and a page script CANNOT enumerate `addEventListener` listeners — so the
 * drawing surface is the only structural signal that "this whole area is draggable". Treating it as
 * interactive keeps those graphs live (the exact regression from #3168); a rare decorative-svg component
 * simply pans via the surrounding gutter. (Wheel-zoom still works over an svg — it's not a scroll
 * container — so zoom is available everywhere the user isn't scrolling.)
 *
 * Returns "" when off, so a non-forwarding srcdoc (the thumbnail) is byte-for-byte unchanged. Vanilla,
 * capture-phase.
 */
export function gestureForwardScript(on: boolean): string {
  if (!on) return "";
  return `\n<script>
(function () {
  var SEL = 'a,button,input,select,textarea,label,summary,option,svg,canvas,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"],[role="slider"],[contenteditable]';
  function interactive(el) {
    for (var n = el; n && n !== document.documentElement && n !== document.body; n = n.parentElement) {
      if (n.nodeType !== 1) continue;
      if (n.matches && n.matches(SEL)) return true;
      var ti = n.getAttribute && n.getAttribute("tabindex");
      if (ti != null && ti !== "-1") return true;
      try { if (getComputedStyle(n).cursor === "pointer") return true; } catch (e) {}
    }
    return false;
  }
  function scrollableAt(el, dy) {
    for (var n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n.nodeType !== 1) continue;
      if (n.scrollHeight <= n.clientHeight) continue;
      var oy; try { oy = getComputedStyle(n).overflowY; } catch (e) { continue; }
      if (oy !== "auto" && oy !== "scroll") continue;
      if (dy < 0 && n.scrollTop > 0) return true;                                  // room to scroll up
      if (dy > 0 && n.scrollTop + n.clientHeight < n.scrollHeight - 1) return true; // room to scroll down
    }
    return false;
  }
  function send(msg) { try { parent.postMessage(msg, "*"); } catch (err) {} }
  var panning = false;
  document.addEventListener("mousedown", function (e) {
    if (e.button !== 0 || interactive(e.target)) return;   // a real control → let the component have it
    e.preventDefault();                                    // else: empty space → this drag pans the host
    panning = true;
    document.body.style.cursor = "grabbing";
    send({ __preview: "panstart", x: e.screenX, y: e.screenY });
  }, true);
  document.addEventListener("mousemove", function (e) { if (panning) send({ __preview: "panmove", x: e.screenX, y: e.screenY }); }, true);
  function end() { if (!panning) return; panning = false; document.body.style.cursor = ""; send({ __preview: "panend" }); }
  document.addEventListener("mouseup", end, true);
  window.addEventListener("blur", end);
  document.addEventListener("wheel", function (e) {
    if (scrollableAt(e.target, e.deltaY)) return;          // let a real scroll container scroll
    e.preventDefault();                                    // else: zoom the host about the cursor
    var w = window.innerWidth || document.documentElement.clientWidth || 1;
    var h = window.innerHeight || document.documentElement.clientHeight || 1;
    send({ __preview: "zoom", dy: e.deltaY, fx: e.clientX / w, fy: e.clientY / h });
  }, { capture: true, passive: false });
})();
</script>`;
}

/**
 * The pan/zoom ENGINE (#3190 crisp pass) — a self-contained `<script>` that pans + zooms the mounted
 * content by transforming `#root` (a DOM transform → the browser re-rasterizes SHARPLY at any scale,
 * unlike CSS-scaling the iframe element, a composited texture that blurs). All coordinates are
 * iframe-local (clientX/clientY), so there's no host↔iframe coordinate conversion. It:
 *   • pans on a non-interactive left-drag (a real control / scroll region is left alone);
 *   • zooms about the cursor on a wheel that isn't over a scroll region;
 *   • obeys host `{__cmd:"zoomIn"|"zoomOut"|"fit"}` messages (the +/−/fit buttons — zoom about center /
 *     reset to identity);
 *   • applies a centered `initial` zoom on load.
 * Returns "" when off. Vanilla, capture-phase; reuses the same interactive/scroll heuristics as the
 * forwarder. `#root` gets `transform-origin: 0 0`; the iframe clips the overflow.
 */
export function gestureEngineScript(cfg: { initial?: number; min?: number; max?: number } | undefined): string {
  if (!cfg) return "";
  const initial = cfg.initial ?? 1;
  const min = cfg.min ?? 0.2;
  const max = cfg.max ?? 8;
  return `\n<script>
(function () {
  var MIN = ${min}, MAX = ${max}, INITIAL = ${initial};
  // A press on a form field keeps its NATIVE drag (text selection / caret); everything else drag-pans.
  var DRAG_NATIVE = 'input,textarea,select,[contenteditable]';
  function dragNative(el) {
    for (var n = el; n && n !== document.documentElement && n !== document.body; n = n.parentElement) {
      if (n.nodeType === 1 && n.matches && n.matches(DRAG_NATIVE)) return true;
    }
    return false;
  }
  function scrollableAt(el, dy) {
    for (var n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n.nodeType !== 1) continue;
      if (n.scrollHeight <= n.clientHeight) continue;
      var oy; try { oy = getComputedStyle(n).overflowY; } catch (e) { continue; }
      if (oy !== "auto" && oy !== "scroll") continue;
      if (dy < 0 && n.scrollTop > 0) return true;
      if (dy > 0 && n.scrollTop + n.clientHeight < n.scrollHeight - 1) return true;
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
  function fit() { view = { tx: 0, ty: 0, scale: 1 }; apply(); }
  // DRAG-PAN: a press-and-MOVE (past a small threshold) pans — ANYWHERE, even over a button — so a
  // component that fills the frame is still draggable; a press-WITHOUT-move stays a CLICK (the control
  // keeps it, since a moved drag suppresses the trailing click).
  var pending = false, panning = false, moved = false, sx = 0, sy = 0, lx = 0, ly = 0;
  document.addEventListener("mousedown", function (e) {
    if (e.button !== 0 || dragNative(e.target)) return;
    pending = true; moved = false; sx = lx = e.clientX; sy = ly = e.clientY;
  }, true);
  document.addEventListener("mousemove", function (e) {
    if (!pending) return;
    if (!panning) {
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 5) return;   // below the drag threshold → not a pan yet
      panning = true; document.body.style.cursor = "grabbing";
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
  // WHEEL: pans/scrolls the content by default (so overflow is navigable); ctrl/⌘ + wheel zooms about the
  // cursor. An inner scroll container scrolls itself.
  document.addEventListener("wheel", function (e) {
    if (scrollableAt(e.target, e.deltaY)) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { zoomAt(Math.exp(-e.deltaY * 0.0016), e.clientX, e.clientY); }
    else { view.tx -= e.deltaX; view.ty -= e.deltaY; apply(); }
  }, { capture: true, passive: false });
  window.addEventListener("message", function (e) {
    var d = e.data; if (!d || typeof d.__cmd !== "string") return;
    var c = centerXY();
    if (d.__cmd === "zoomIn") zoomAt(1.2, c[0], c[1]);
    else if (d.__cmd === "zoomOut") zoomAt(1 / 1.2, c[0], c[1]);
    else if (d.__cmd === "fit") fit();
  });
  fit(); if (INITIAL !== 1) { zoomAt(INITIAL, centerXY()[0], 0); }  // initial zoom anchored at the TOP so a page's headers stay visible (crop the bottom, not the top)
})();
</script>`;
}

/**
 * Assemble the sandboxed-iframe srcdoc: import-map for the externals + the injected app CSS + the bundle
 * as a module, posting `ready`/`error` to the parent. Pure.
 */
export function buildComponentSrcDoc(bundleJs: string, opts: ComponentSrcDocOptions = {}): string {
  const { injectedCss = "", theme = "dark", importmap = COMPONENT_IMPORTMAP, rootClass = "", exitSelectors = [], fitContent = false, forwardGestures = false, scrollY = false, zoomEngine } = opts;
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
  // #3190: the gesture-forward shim — lets a non-interactive drag pan + a non-scroll wheel zoom the host
  // viewport (the iframe decides per event and postMessages the survivors out). "" (unchanged) when off.
  const gestureShim = gestureForwardScript(forwardGestures);
  // #3190 crisp pass: the in-iframe pan/zoom ENGINE — transforms `#root` (crisp DOM) instead of forwarding
  // to a host CSS scale (a blurry iframe texture). Clip cleanly + no scrollbars while it drives the view.
  const engineShim = gestureEngineScript(zoomEngine);
  // #3251: the engine's drag lives INSIDE the iframe, so the selection guard must too — the host
  // wrapper's `user-select:none` cannot cross a document boundary. Without this, a press-and-move
  // starts a native text selection instead of panning. Form fields keep caret + selection (mirrors the
  // engine's own DRAG_NATIVE list, which already leaves their native drag alone).
  const engineCss = zoomEngine
    ? `\n<style>html,body{overflow:hidden}#root{overflow:hidden}`
      + `body{user-select:none;-webkit-user-select:none}`
      + `input,textarea,select,[contenteditable]{user-select:text;-webkit-user-select:text}</style>`
    : "";
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8" />
<style>html,body,#root{margin:0;height:100%;box-sizing:border-box}#root{overflow:auto}*,*::before,*::after{box-sizing:inherit}
/* Fit oversized preview media (d3 charts/graphs, images) within the frame rather than overflowing it (#2915).
   Aspect-preserving on replaced/viewBox elements; the definite height chain above lets max-height:100% resolve.
   Fluid (width:100%) components are unaffected — the caps only bite oversized fixed-dimension media. */
#root svg,#root canvas,#root img,#root video{max-width:100%;max-height:100%}</style>${scrollCss}${engineCss}
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
</script>${fitShim}${gestureShim}${engineShim}
</body></html>`;
}
