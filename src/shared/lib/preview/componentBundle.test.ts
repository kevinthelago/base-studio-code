import { describe, it, expect } from "vitest";
import { compileAnimationsCss, kitAnimations } from "@/shared/ui/kit";
import {
  resolveMemPath, lookupMem, buildComponentSrcDoc, exitShimScript, fitShimScript, panForwardScript, COMPONENT_IMPORTMAP, COMPONENT_EXTERNALS,
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

describe("componentBundle — pan-forward shim (#3190)", () => {
  it("injects the shim (interactive guard + panstart/move/end forwarding) when panForward is set", () => {
    const doc = buildComponentSrcDoc("/*B*/", { panForward: true });
    expect(doc).toContain('__preview: type');                 // posts the pan events to the host
    expect(doc).toContain('"panstart"');                      // …starting with panstart
    expect(doc).toContain('"panmove"');                       // …then panmove
    expect(doc).toContain('"panend"');                        // …then panend
    expect(doc).toContain("e.button !== 0");                  // only a LEFT drag pans
    expect(doc).toContain('cursor === "pointer"');            // a cursor:pointer ancestor counts as interactive
    expect(doc).toContain("e.preventDefault()");              // a non-interactive press is claimed for panning
    // The pan shim comes AFTER the module script (its listeners don't need the component mounted, but it
    // rides in with the other post-body shims).
    expect(doc.indexOf('__preview: type')).toBeGreaterThan(doc.indexOf('<script type="module">'));
  });

  it("injects NOTHING when panForward is off — the srcdoc is byte-for-byte unchanged", () => {
    const bare = buildComponentSrcDoc("X");
    expect(buildComponentSrcDoc("X", { panForward: false })).toBe(bare);
    for (const doc of [bare, buildComponentSrcDoc("X", { panForward: false })]) {
      expect(doc).not.toContain('__preview: type');
      expect(doc).not.toContain('"panstart"');
    }
  });

  it("panForwardScript returns a plain script when on; empty string otherwise", () => {
    expect(panForwardScript(false)).toBe("");
    const shim = panForwardScript(true);
    expect(shim.startsWith("\n<script>")).toBe(true);         // a plain (non-module) capture-phase script
    expect(shim).toContain('[role="button"]');               // ARIA controls count as interactive
    expect(shim).toContain('[contenteditable]');             // …as does an editable region
    expect(shim).toContain("svg,canvas");                    // …and a data-viz drawing surface (#3168 regression)
    expect(shim).toContain('ti !== "-1"');                   // a focusable (tabindex) ancestor counts too
    expect(shim).toContain("screenX");                       // forwards absolute screen coords (delta host-side)
  });

  it("drives the runtime in jsdom: a background drag forwards pan events; a button press does not", () => {
    // Execute the shim in this jsdom global (strip the <script> wrapper). Indirect eval → global scope.
    const src = panForwardScript(true).replace(/^\s*<script>/, "").replace(/<\/script>\s*$/, "");
    const posts: Array<{ type: string; x: number; y: number }> = [];
    const origPost = window.parent.postMessage;
    // jsdom's window.parent === window; capture what the shim posts to the host.
    (window.parent as unknown as { postMessage: (m: unknown) => void }).postMessage = (m: unknown) => {
      const d = m as { __preview: string; x: number; y: number };
      posts.push({ type: d.__preview, x: d.x, y: d.y });
    };

    const bg = document.createElement("div");   // empty background — a drag here should pan
    const btn = document.createElement("button"); // a real control — a drag here must NOT pan
    document.body.append(bg, btn);
    (0, eval)(src);

    // A left press on the background → panstart, then panmove deltas, then panend.
    bg.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, screenX: 10, screenY: 20 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, screenX: 15, screenY: 26 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(posts.map((p) => p.type)).toEqual(["panstart", "panmove", "panend"]);
    expect(posts[0]).toMatchObject({ x: 10, y: 20 });
    expect(posts[1]).toMatchObject({ x: 15, y: 26 }); // absolute coords; the host computes (5,6)

    // A press on a button forwards nothing — the component keeps the interaction.
    posts.length = 0;
    btn.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, screenX: 5, screenY: 5 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, screenX: 9, screenY: 9 }));
    expect(posts).toEqual([]);

    // A press inside a chart's SVG surface (a d3 graph node) forwards nothing — the graph stays draggable.
    posts.length = 0;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    svg.appendChild(circle);
    document.body.appendChild(svg);
    circle.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, screenX: 3, screenY: 3 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, screenX: 7, screenY: 7 }));
    expect(posts).toEqual([]);
    document.body.removeChild(svg);

    // A non-left (e.g. right) press on the background is ignored too.
    bg.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true, screenX: 1, screenY: 1 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, screenX: 4, screenY: 4 }));
    expect(posts).toEqual([]);

    window.parent.postMessage = origPost;
    document.body.removeChild(bg);
    document.body.removeChild(btn);
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
