import { describe, it, expect } from "vitest";
import { compileAnimationsCss, kitAnimations } from "@/shared/ui/kit";
import {
  resolveMemPath, lookupMem, buildComponentSrcDoc, exitShimScript, fitShimScript, gestureEngineScript, COMPONENT_IMPORTMAP, COMPONENT_EXTERNALS,
} from "./componentBundle";

// The esbuild-wasm bundle can't run under jsdom; these cover the PURE pieces (path resolution + srcdoc
// assembly). The end-to-end bundle is exercised in the running app.

describe("componentBundle — resolveMemPath", () => {
  it("resolves a relative import against the importer's directory", () => {
    expect(resolveMemPath("shared/ui/data/Card.tsx", "./chip")).toBe("shared/ui/data/chip");
    expect(resolveMemPath("shared/ui/data/Card.tsx", "../feedback/Skeleton")).toBe("shared/ui/feedback/Skeleton");
    expect(resolveMemPath("a/b/c.tsx", "../../x")).toBe("x");
  });
});

describe("componentBundle — lookupMem", () => {
  const files = { "shared/ui/data/Card.tsx": "CARD", "shared/lib/x/index.ts": "IDX" };
  it("finds a file by trying TS/JS extensions and index files", () => {
    expect(lookupMem(files, "shared/ui/data/Card")?.contents).toBe("CARD");
    expect(lookupMem(files, "shared/ui/data/Card")?.loader).toBe("tsx");
    expect(lookupMem(files, "shared/lib/x")?.contents).toBe("IDX"); // index resolution
    expect(lookupMem(files, "nope")).toBeNull();
  });

  it("loads an EXTENSIONLESS key (a `src` recorded as a directory) as tsx, not jsx (#3549)", () => {
    // WorkspaceShellPage's `src` was `src/shared/ui/layouts` — no extension — and its source is
    // TypeScript (`import type {…}`). The extensionless key must resolve to the tsx loader, else esbuild
    // parses the TS with the jsx loader and fails: `Expected "from" but found "{"`.
    const dirKeyed = { "src/shared/ui/layouts": "import type { ReactNode } from 'react';" };
    expect(lookupMem(dirKeyed, "src/shared/ui/layouts")?.loader).toBe("tsx");
  });

  it("keeps an explicit .jsx/.js key on the jsx loader (only tsx is the widened default)", () => {
    const js = { "boot.jsx": "JSX", "util.js": "JS" };
    expect(lookupMem(js, "boot")?.loader).toBe("jsx");
    expect(lookupMem(js, "util")?.loader).toBe("jsx");
  });
});

describe("componentBundle — buildComponentSrcDoc", () => {
  it("embeds the import-map, injected CSS, theme, the bundle, and a ready signal", () => {
    const doc = buildComponentSrcDoc("/*BUNDLE*/const x=1;", { injectedCss: ".card{color:red}", theme: "light" });
    expect(doc).toContain(COMPONENT_IMPORTMAP["react"]);        // esm.sh react in the import-map
    expect(doc).toContain(".card{color:red}");                  // injected app CSS
    expect(doc).toContain('data-theme="light"');               // theme attribute for token overrides
    expect(doc).toContain("/*BUNDLE*/const x=1;");             // the bundle as a module
    expect(doc).toContain('__preview: "ready"');               // ready signal to the host
    expect(doc).toContain('__preview: "error"');               // error signal to the host
  });

  it("defaults to the shared import-map + dark theme", () => {
    const doc = buildComponentSrcDoc("X");
    expect(doc).toContain('data-theme="dark"');
    expect(doc).toContain(COMPONENT_IMPORTMAP["react"]);
  });

  it("puts the animation classes on #root, or a bare #root when there are none (#2870)", () => {
    expect(buildComponentSrcDoc("X", { rootClass: "card-anim-fade-in" })).toContain('<div id="root" class="card-anim-fade-in">');
    expect(buildComponentSrcDoc("X")).toContain('<div id="root"></div>'); // no class attribute when empty
  });

  it("caps oversized media so a component fits the frame instead of overflowing (#2915)", () => {
    const doc = buildComponentSrcDoc("X");
    // The definite height chain lets a percentage max-height resolve, and media is capped both ways.
    expect(doc).toContain("html,body,#root{margin:0;height:100%");
    expect(doc).toContain("#root svg,#root canvas,#root img,#root video{max-width:100%;max-height:100%}");
  });

  it("posts a post-mount `rendered` empty-render report to the host (#2926)", () => {
    const doc = buildComponentSrcDoc("X");
    expect(doc).toContain('__preview: "rendered"');           // the empty-render signal
    expect(doc).toContain('querySelectorAll("*").length <= 1'); // measured: no element beyond the wrapper
    expect(doc).toContain('.trim().length === 0');             // …AND no text
  });

  it("carries a kit's compiled motion into the iframe, reduced-motion-guarded (#2942)", () => {
    // The preview path: compile a kit's animations → inject the CSS + apply the `.<kit>-anim-<name>`
    // class on #root.
    const defs = kitAnimations([{ id: "react-ui", animations: [{ name: "fade-in", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } } }] }]);
    const doc = buildComponentSrcDoc("X", {
      injectedCss: compileAnimationsCss(defs),
      rootClass: defs.map((d) => `${d.kit}-anim-${d.name}`).join(" "),
    });
    expect(doc).toContain("@keyframes bsc-react-ui-fade-in");                // the keyframes reach the iframe
    expect(doc).toContain("@media (prefers-reduced-motion: no-preference)"); // motion suppressed for reduced-motion viewers
    expect(doc).toContain('<div id="root" class="react-ui-anim-fade-in">');   // #root carries the applying class → it plays
  });
});

describe("componentBundle — exit-runtime shim (#3057)", () => {
  it("injects the shim (observer + guards + marker) when exit selectors are given", () => {
    const doc = buildComponentSrcDoc("/*B*/", { exitSelectors: [".tooltip"] });
    expect(doc).toContain('[".tooltip"]');                      // the selector list, JSON-embedded
    expect(doc).toContain("MutationObserver");                  // watches #root for leaving subtrees
    expect(doc).toContain("(prefers-reduced-motion: reduce)");  // reduced-motion bypass
    expect(doc).toContain('setAttribute("data-bsc-exit"');      // flips the marker the dormant rule keys on
    expect(doc).toContain("animationend");                      // plays-to-completion cleanup
    expect(doc).toContain("setTimeout(finish, 1200)");          // the missing-animationend backstop
    // The shim runs BEFORE the module script (so the observer is watching before React mounts/unmounts).
    expect(doc.indexOf("MutationObserver")).toBeLessThan(doc.indexOf('<script type="module">'));
    // …and AFTER #root (the observer's target exists when the shim runs).
    expect(doc.indexOf('<div id="root"')).toBeLessThan(doc.indexOf("MutationObserver"));
  });

  it("injects NOTHING when there are no exit selectors — the non-exit srcdoc is unchanged", () => {
    const bare = buildComponentSrcDoc("X");
    // `[]` and the default (absent) must be byte-for-byte identical to no option at all.
    expect(buildComponentSrcDoc("X", { exitSelectors: [] })).toBe(bare);
    for (const doc of [bare, buildComponentSrcDoc("X", { exitSelectors: [] })]) {
      expect(doc).not.toContain("MutationObserver");
      expect(doc).not.toContain("data-bsc-exit");
      expect(doc).not.toContain("(prefers-reduced-motion: reduce)");
      expect(doc).not.toContain("animationend");
    }
  });

  it("exitShimScript embeds the selectors and every guard; empty ⇒ empty string", () => {
    expect(exitShimScript([])).toBe("");
    const shim = exitShimScript([".tooltip", "[data-toast]"]);
    expect(shim).toContain('[".tooltip","[data-toast]"]'); // both selectors, JSON-embedded, in order
    expect(shim).toContain("new WeakSet()");               // the loop guard
    expect(shim).toContain("exiting.has(node)");           // …consulted so re-inserts/removes are ignored
    expect(shim).toContain("parent.isConnected");          // re-home only under a live parent
    expect(shim).toContain("record.nextSibling");          // position reconstruction
    expect(shim).toContain("(prefers-reduced-motion: reduce)"); // reduced-motion bypass
    expect(shim).toContain('{ once: true }');              // one-shot animationend
    expect(shim).toContain("setTimeout(finish, 1200)");    // backstop
    expect(shim.startsWith("\n<script>")).toBe(true);      // a plain (non-module) script block
  });

  it("drives the runtime in jsdom: re-homes a leaving match and flips data-bsc-exit", async () => {
    // jsdom has MutationObserver but no CSS animations / `animationend`, so this exercises the
    // OBSERVE → re-home → mark path (the part that makes the exit rule match). The animation playback +
    // the `animationend`-driven removal need a live browser; only the 1200ms backstop would remove the
    // node here, which we don't wait for.
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    const tip = document.createElement("div");
    tip.className = "tooltip";
    const keep = document.createElement("div"); // an ordinary (non-matching) sibling
    root.append(tip, keep);

    // Execute the shim in this jsdom global (strip the <script> wrapper). Indirect eval → global scope,
    // where document/window/MutationObserver/Element/WeakSet all resolve.
    const src = exitShimScript([".tooltip"]).replace(/^\s*<script>/, "").replace(/<\/script>\s*$/, "");
    (0, eval)(src);

    // An ordinary unmount of a NON-matching node is left alone.
    root.removeChild(keep);
    await new Promise((r) => setTimeout(r, 0));
    expect(root.contains(keep)).toBe(false);

    // A matching node is re-homed and marked so the dormant exit rule would play.
    root.removeChild(tip);
    await new Promise((r) => setTimeout(r, 0)); // flush the MutationObserver microtask
    expect(root.contains(tip)).toBe(true);              // re-inserted under #root by the shim
    expect(tip.getAttribute("data-bsc-exit")).toBe(""); // marker flipped

    document.body.removeChild(root);
  });
});

describe("componentBundle — scale-to-fit shim (#3141)", () => {
  it("injects the shim (measure + scale + overflow clip) when fitContent is set, AFTER the module script", () => {
    const doc = buildComponentSrcDoc("/*B*/", { fitContent: true });
    expect(doc).toContain('root.style.overflow = "hidden"'); // fit by scaling, not scrolling
    expect(doc).toContain("content.offsetWidth");            // measures the component's natural size
    expect(doc).toContain('scale("');                        // applies a transform scale
    expect(doc).toContain("ResizeObserver");                 // re-fits on frame resize
    // The shim runs AFTER the module script (so the component is mounted when it measures).
    expect(doc.indexOf("content.offsetWidth")).toBeGreaterThan(doc.indexOf('<script type="module">'));
  });

  it("injects NOTHING when fitContent is off — the srcdoc is byte-for-byte unchanged", () => {
    const bare = buildComponentSrcDoc("X");
    expect(buildComponentSrcDoc("X", { fitContent: false })).toBe(bare);
    for (const doc of [bare, buildComponentSrcDoc("X", { fitContent: false })]) {
      expect(doc).not.toContain('root.style.overflow = "hidden"');
      expect(doc).not.toContain("content.offsetWidth");
    }
  });

  it("fitShimScript returns a module script when fitting; empty string otherwise", () => {
    expect(fitShimScript(false)).toBe("");
    const shim = fitShimScript(true);
    expect(shim.startsWith('\n<script type="module">')).toBe(true); // runs post-mount (deferred module)
    expect(shim).toContain("Math.min(1,");                          // never scales UP — only down to fit
    expect(shim).toContain("transformOrigin");                      // scales about the center
  });

  it("drives the runtime in jsdom: scales an overflowing component down, leaves a fitting one alone", async () => {
    // jsdom has no layout engine (offset*/client* are 0), so stub the sizes the shim reads. The shim uses
    // the timed passes (no ResizeObserver in jsdom) — await past the 120ms pass to see the transform.
    function mount(rootW: number, rootH: number, contentW: number, contentH: number) {
      const root = document.createElement("div");
      root.id = "root";
      Object.defineProperty(root, "clientWidth", { value: rootW, configurable: true });
      Object.defineProperty(root, "clientHeight", { value: rootH, configurable: true });
      const wrap = document.createElement("div");
      const content = document.createElement("div");
      Object.defineProperty(content, "offsetWidth", { value: contentW, configurable: true });
      Object.defineProperty(content, "offsetHeight", { value: contentH, configurable: true });
      wrap.appendChild(content);
      root.appendChild(wrap);
      document.body.appendChild(root);
      return { root, content };
    }
    const run = (shim: string) => (0, eval)(shim.replace(/^\s*<script type="module">/, "").replace(/<\/script>\s*$/, ""));

    // Overflows vertically (400 tall in a 200 frame) → scales to min(1, .94*200/100, .94*200/400) = 0.47.
    const over = mount(200, 200, 100, 400);
    run(fitShimScript(true));
    await new Promise((r) => setTimeout(r, 200));
    expect(over.content.style.transform).toBe("scale(0.47)");
    expect(over.root.style.overflow).toBe("hidden");
    document.body.removeChild(over.root);

    // Already fits (small component) → k clamps to 1 → no scaling.
    const fits = mount(200, 200, 40, 20);
    run(fitShimScript(true));
    await new Promise((r) => setTimeout(r, 200));
    expect(fits.content.style.transform).toBe("none");
    document.body.removeChild(fits.root);
  });
});

describe("componentBundle — scrollY natural-size mode (#3190)", () => {
  it("overrides the mount wrapper to a growing block so tall content scrolls (#root already overflow:auto)", () => {
    const doc = buildComponentSrcDoc("X", { scrollY: true });
    expect(doc).toContain("#root>*{display:block!important;height:auto!important;min-height:100%}"); // wrapper → growing block
    expect(doc).toContain("#root{overflow:auto}"); // the scroll container (base CSS, unchanged)
  });

  it("suppresses the scale-to-fit shim under scrollY (natural size, not scaled) — even if fitContent is set", () => {
    const doc = buildComponentSrcDoc("X", { scrollY: true, fitContent: true });
    expect(doc).not.toContain("content.offsetWidth"); // the fit-shim's measure — absent
    expect(doc).toContain("#root>*{display:block!important"); // the scroll override instead
  });

  it("injects NOTHING when scrollY is off — the srcdoc is byte-for-byte unchanged", () => {
    const bare = buildComponentSrcDoc("X");
    expect(buildComponentSrcDoc("X", { scrollY: false })).toBe(bare);
    expect(bare).not.toContain("display:block!important");
  });
});

describe("componentBundle — pan/zoom engine (#3190 crisp pass)", () => {
  it("gestureEngineScript embeds the params + host-command handling; undefined ⇒ empty", () => {
    expect(gestureEngineScript(undefined)).toBe("");
    const s = gestureEngineScript({ min: 0.3, max: 6 });
    expect(s.startsWith("\n<script>")).toBe(true);
    expect(s).toContain("MIN = 0.3");
    expect(s).toContain("MAX = 6");
    expect(s).toContain('getElementById("root")');   // transforms #root (a DOM transform → crisp)
    expect(s).toContain("typeof d.__cmd");            // obeys host zoomIn/zoomOut/fit commands
    expect(s).toContain("DRAG_NATIVE");               // form fields keep their native drag; else drag-pans
    expect(s).toContain("scrollWidth");               // FIT measures the content to show the whole component
  });

  it("buildComponentSrcDoc injects the engine + a NON-clipping content box under zoomEngine, suppressing the fit-shim", () => {
    const doc = buildComponentSrcDoc("X", { zoomEngine: {}, fitContent: true });
    expect(doc).toContain('getElementById("root")');        // the engine is present
    expect(doc).toContain("html,body{overflow:hidden}");    // no scrollbars — the frame is the viewport
    // #3551: #root and the mount wrapper must NOT clip, so the full component height renders + is measurable.
    expect(doc).toContain("#root{overflow:visible}");
    expect(doc).toContain("min-height:100%;overflow:visible!important");
    expect(doc).not.toContain("#root{overflow:hidden}");    // the old clip that cut off overflow is gone
    expect(doc).not.toContain("content.offsetWidth");       // the scale-to-fit shim is suppressed
    const bare = buildComponentSrcDoc("X");
    expect(buildComponentSrcDoc("X", { zoomEngine: undefined })).toBe(bare); // off ⇒ byte-for-byte unchanged
  });

  // #3251 regression: the engine's drag lives INSIDE the iframe, so its selection guard must ship in the
  // SRCDOC. The host wrapper's `user-select:none` cannot cross a document boundary — when that was the
  // only guard, a press-and-move started a native text selection instead of panning.
  it("the engine's srcdoc suppresses text selection, exempting form fields (#3251)", () => {
    const doc = buildComponentSrcDoc("X", { zoomEngine: {} });
    expect(doc).toContain("body{user-select:none;-webkit-user-select:none}");
    // …but a previewed input/textarea keeps its caret + selection (mirrors the engine's DRAG_NATIVE).
    expect(doc).toContain("input,textarea,select,[contenteditable]{user-select:text;-webkit-user-select:text}");
    // Scoped to the engine only: a non-engine preview is untouched.
    expect(buildComponentSrcDoc("X")).not.toContain("user-select");
  });

  // Parse "translate(<tx>px,<ty>px) scale(<s>)" — the transform the engine writes onto #root.
  const parseT = (s: string) => {
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\((-?[\d.]+)\)/.exec(s);
    return m ? { tx: +m[1], ty: +m[2], scale: +m[3] } : null;
  };

  it("drives the engine in jsdom: fit-on-open, drag-pan (click still interacts), wheel-ZOOM, cmds", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    const src = gestureEngineScript({}).replace(/^\s*<script>/, "").replace(/<\/script>\s*$/, "");
    (0, eval)(src);
    const fit = () => window.dispatchEvent(new MessageEvent("message", { data: { __cmd: "fit" } }));

    // OPEN = FIT. In jsdom #root has no layout (scrollWidth/Height = 0), so fit falls back to identity —
    // the measured-and-scaled fit is exercised by the browser e2e (previewInteraction.spec.ts).
    let t = parseT(root.style.transform)!;
    expect(t).toEqual({ tx: 0, ty: 0, scale: 1 });

    // FIT (unmeasured) stays identity.
    fit();
    expect(parseT(root.style.transform)).toEqual({ tx: 0, ty: 0, scale: 1 });

    // DRAG-PAN (past the 5px threshold) translates by the mouse delta.
    root.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, clientX: 100, clientY: 100 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 130, clientY: 112 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(parseT(root.style.transform)).toEqual({ tx: 30, ty: 12, scale: 1 });

    // Even over a BUTTON, a DRAG pans — and the trailing click is suppressed so it doesn't also interact.
    fit();
    const btn = document.createElement("button");
    root.appendChild(btn);
    let clicked = false;
    btn.addEventListener("click", () => { clicked = true; });
    btn.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, clientX: 50, clientY: 50 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 80, clientY: 60 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(parseT(root.style.transform)).toEqual({ tx: 30, ty: 10, scale: 1 });  // the button-drag panned
    expect(clicked).toBe(false);                                                 // …click suppressed

    // A plain CLICK (no move) does NOT pan and DOES reach the control.
    fit();
    const before = root.style.transform;
    clicked = false;
    btn.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, clientX: 50, clientY: 50 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(root.style.transform).toBe(before);
    expect(clicked).toBe(true);

    // WHEEL = ZOOM about the cursor (NO modifier needed). Scroll UP (deltaY<0) zooms IN, and the point
    // under the cursor stays fixed. Drag — tested above — is what pans across the screen.
    fit();
    root.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120, clientX: 200, clientY: 150 }));
    t = parseT(root.style.transform)!;
    expect(t.scale).toBeGreaterThan(1);
    expect(200 * t.scale + t.tx).toBeCloseTo(200, 3);
    expect(150 * t.scale + t.ty).toBeCloseTo(150, 3);

    // Scroll DOWN (deltaY>0) zooms OUT.
    fit();
    root.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120, clientX: 200, clientY: 150 }));
    expect(parseT(root.style.transform)!.scale).toBeLessThan(1);

    // HOST +/− commands zoom about center.
    fit();
    window.dispatchEvent(new MessageEvent("message", { data: { __cmd: "zoomIn" } }));
    expect(parseT(root.style.transform)!.scale).toBeCloseTo(1.2, 6);

    root.remove();
  });

  // #3251 regression: an <img>/<a> press starts a NATIVE drag, which cancels the mousemove stream and
  // kills the pan mid-gesture. The engine cancels it; a form field keeps its own (DRAG_NATIVE).
  it("cancels a native dragstart on non-form targets, so an image/link drag still pans (#3251)", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    const src = gestureEngineScript({}).replace(/^\s*<script>/, "").replace(/<\/script>\s*$/, "");
    (0, eval)(src);

    const img = document.createElement("img");
    root.appendChild(img);
    const imgDrag = new Event("dragstart", { bubbles: true, cancelable: true });
    img.dispatchEvent(imgDrag);
    expect(imgDrag.defaultPrevented).toBe(true);      // native image-drag cancelled → the pan survives

    const input = document.createElement("input");
    root.appendChild(input);
    const inputDrag = new Event("dragstart", { bubbles: true, cancelable: true });
    input.dispatchEvent(inputDrag);
    expect(inputDrag.defaultPrevented).toBe(false);   // a form field keeps its native drag

    root.remove();
  });
});

describe("componentBundle — externals", () => {
  it("derives the external set from the import-map keys (pinned to esm.sh)", () => {
    expect(COMPONENT_EXTERNALS).toEqual(Object.keys(COMPONENT_IMPORTMAP));
    expect(COMPONENT_EXTERNALS).toContain("react");
    for (const url of Object.values(COMPONENT_IMPORTMAP)) expect(url).toMatch(/^https:\/\/esm\.sh\//);
  });

  it("pins d3 + d3-force so react-d3 kit previews resolve deterministically (#2930)", () => {
    expect(COMPONENT_IMPORTMAP["d3"]).toMatch(/^https:\/\/esm\.sh\/d3@\d/);
    expect(COMPONENT_IMPORTMAP["d3-force"]).toMatch(/^https:\/\/esm\.sh\/d3-force@\d/);
    // …and they ride into the srcdoc's import-map so the iframe resolves them without re-fetching latest.
    const doc = buildComponentSrcDoc("X");
    expect(doc).toContain(COMPONENT_IMPORTMAP["d3-force"]);
  });
});
