import { describe, it, expect } from "vitest";
import { compileAnimationsCss, kitAnimations } from "@/shared/ui/kit";
import {
  resolveMemPath, lookupMem, buildComponentSrcDoc, exitShimScript, COMPONENT_IMPORTMAP, COMPONENT_EXTERNALS,
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
