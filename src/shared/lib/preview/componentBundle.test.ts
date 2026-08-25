/**
 * @vitest-environment jsdom
 *
 * This file lives under `lib/`, which vitest's `node` project covers, but it genuinely needs a DOM.
 * A per-file docblock beats the project's environment, so the requirement is stated where a reader
 * meets it. See the `projects` split in vitest.config.ts for why the default is `node` here.
 */
import { describe, it, expect } from "vitest";
import { compileAnimationsCss, kitAnimations } from "@/shared/ui/kit";
import { dataJsonSpec, dataJsonModule } from "@/shared/lib/preview/componentBundle";
import {
  resolveMemPath, lookupMem, loaderFor, stubsBoundaryModule, buildComponentSrcDoc, exitShimScript, fitShimScript, gestureEngineScript, inspectEngineScript, COMPONENT_IMPORTMAP, COMPONENT_EXTERNALS,
  PREVIEW_DEFINE, PREVIEW_GLOB_BANNER, PREVIEW_GLOB_SHIM,
  rawImportSpec, rawModuleSource, rawModuleText,
} from "./componentBundle";

// The esbuild-wasm bundle can't run under jsdom; these cover the PURE pieces (path resolution + srcdoc
// assembly). The end-to-end bundle is exercised in the running app.

describe("componentBundle — resolveMemPath", () => {
  it("resolves a relative import against the importer's directory", () => {
    expect(resolveMemPath("shared/ui/data/Card.tsx", "./chip")).toBe("shared/ui/data/chip");
    expect(resolveMemPath("shared/ui/data/Card.tsx", "../feedback/Skeleton")).toBe("shared/ui/feedback/Skeleton");
    expect(resolveMemPath("a/b/c.tsx", "../../x")).toBe("x");
  });

  it("resolves a BARREL's relative import against its own directory, not its parent", () => {
    // #a-barrel-import-resolves-against-its-own-directory. `lookupMem` accepts `shared/ui/kit` by trying
    // `/index.ts`, so a barrel loads under its DIRECTORY id while its contents come from the index.
    // Stripping the last segment then resolved `./theme` to `shared/ui/theme` — which does not exist —
    // and every component importing the kit failed to build: 34 of them, every *GraphHost among them.
    const files = {
      "shared/ui/kit/index.ts": "export * from './theme';",
      "shared/ui/kit/theme.ts": "export const t = 1;",
      "shared/ui/kit/ThemeScope.tsx": "export const S = 1;",
    };
    expect(resolveMemPath("shared/ui/kit", "./theme", files)).toBe("shared/ui/kit/theme");
    expect(resolveMemPath("shared/ui/kit", "./ThemeScope", files)).toBe("shared/ui/kit/ThemeScope");
  });

  it("still strips the basename for a REAL file importer — and `..` climbs the same from both", () => {
    // The half a naive fix breaks. `..` must mean the same thing whether the importer id is a file or an
    // index-backed directory, because in the real tree they are the same position.
    const files = {
      "shared/ui/kit/index.ts": "x",
      "shared/ui/data/Card.tsx": "x",
      "shared/ui/feedback/Skeleton.tsx": "x",
    };
    expect(resolveMemPath("shared/ui/data/Card.tsx", "./chip", files)).toBe("shared/ui/data/chip");
    expect(resolveMemPath("shared/ui/data/Card.tsx", "../feedback/Skeleton", files)).toBe("shared/ui/feedback/Skeleton");
    expect(resolveMemPath("shared/ui/kit", "../feedback/Skeleton", files)).toBe("shared/ui/feedback/Skeleton");
  });

  it("without a file map, behaves exactly as it did — the parameter is additive", () => {
    // Existing callers and the pure tests pass two args; only the esbuild plugin passes three. A change
    // in the two-arg behaviour would be a silent regression in whatever still calls it that way.
    expect(resolveMemPath("shared/ui/kit", "./theme")).toBe("shared/ui/theme");
    expect(resolveMemPath("shared/ui/data/Card.tsx", "./chip")).toBe("shared/ui/data/chip");
  });
});

// The DECLARED BOUNDARY (#3897): a registered `@/…` the files do not vendor resolves to a bundled-in stub
// instead of a mem-filesystem miss. Vendored wins; unregistered is never stubbed. (That the stub then
// BUILDS and RENDERS needs real Chromium — `e2e/previewShims.spec.ts`.)
describe("componentBundle — stubsBoundaryModule", () => {
  const files = { "shared/ui/data/Card.tsx": "export function Card() {}" };

  it("stubs a REGISTERED platform module the files do not vendor", () => {
    expect(stubsBoundaryModule(files, "@/store")).toBe(true);
    expect(stubsBoundaryModule(files, "@/shared/ui/layout/Stack")).toBe(true);
  });

  it("prefers the VENDORED source over a stub, even for a registered specifier", () => {
    // `@/shared/ui/data/Card` is registered, but it is handed in — real source must win.
    expect(stubsBoundaryModule(files, "@/shared/ui/data/Card")).toBe(false);
  });

  it("never stubs an UNREGISTERED @/ — a missing sibling stays an honest 'module not found'", () => {
    expect(stubsBoundaryModule(files, "@/react-d3/Nope")).toBe(false);
  });

  it("never stubs a non-first-party specifier (@bsc/ libraries and bare packages are unchanged)", () => {
    expect(stubsBoundaryModule(files, "@bsc/algorithms/fib")).toBe(false);
    expect(stubsBoundaryModule(files, "expo-router")).toBe(false);
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

  it("never loads an EXTENSIONLESS key as jsx (#3549), and picks ts vs tsx by its source (#79)", () => {
    // WorkspaceShellPage's `src` was `src/shared/ui/layouts` — no extension — and its source is
    // TypeScript (`import type {…}`). The jsx loader fails on it outright: `Expected "from" but
    // found "{"`. That guard is unchanged; #79 only sharpens WHICH TypeScript loader it gets, since
    // tsx is not a superset of ts.
    const dirKeyed = { "src/shared/ui/layouts": "import type { ReactNode } from 'react';" };
    expect(lookupMem(dirKeyed, "src/shared/ui/layouts")?.loader).not.toBe("jsx");
    expect(lookupMem(dirKeyed, "src/shared/ui/layouts")?.loader).toBe("ts"); // no JSX in it
    // …and the same key whose source really is JSX gets tsx.
    const jsxKeyed = { "src/shared/ui/layouts": "export const S = () => <div className='x' />;" };
    expect(lookupMem(jsxKeyed, "src/shared/ui/layouts")?.loader).toBe("tsx");
  });

  it("keeps an explicit .jsx/.js key on the jsx loader (only tsx is the widened default)", () => {
    const js = { "boot.jsx": "JSX", "util.js": "JS" };
    expect(lookupMem(js, "boot")?.loader).toBe("jsx");
    expect(lookupMem(js, "util")?.loader).toBe("jsx");
  });
});

describe("componentBundle — loaderFor (#79, designer request)", () => {
  // THE CONSTRUCT THE REQUEST WAS FILED FOR: deployEnv.ts line 99. Valid TypeScript in a .ts file;
  // JSX in a .tsx file. Verified against the real esbuild-wasm this bundler uses:
  //   ts   OK
  //   tsx  FAIL  The character ">" is not valid inside a JSX element
  //   jsx  FAIL  Expected ";" but found "P"
  // So this is a language-level conflict, not a tuning choice — tsx is NOT a superset of ts, and a
  // JSX-free module reached through a barrel could not be built at all before this.
  const GENERIC_ARROW = "type P = { id: string };\nconst clone = <T>(v: T): T => structuredClone(v);\nexport { clone };";

  it("gives a JSX-free TypeScript module the plain ts loader, whatever its key", () => {
    expect(loaderFor("features/planner/lib/deployEnv", GENERIC_ARROW)).toBe("ts");
    expect(loaderFor("features/planner/lib/deployEnv.ts", GENERIC_ARROW)).toBe("ts");
  });

  it("an explicit extension decides, and only an extensionless key consults the source", () => {
    expect(loaderFor("a.tsx", "export const A = 1;")).toBe("tsx"); // no JSX in it, but .tsx says tsx
    expect(loaderFor("a.ts", "export const A = 1;")).toBe("ts");
    expect(loaderFor("a.jsx", "export const A = 1;")).toBe("jsx");
    expect(loaderFor("a.js", "export const A = 1;")).toBe("jsx");
  });

  it("reads JSX off the source for an extensionless key — both tag shapes", () => {
    expect(loaderFor("Card", "export const C = () => <div>hi</div>;")).toBe("tsx"); // closing tag
    expect(loaderFor("Icon", "export const I = () => <Glyph name='x' />;")).toBe("tsx"); // self-closing
    expect(loaderFor("pure", "export const n: number = 1 > 0 ? 1 : 0;")).toBe("ts"); // a bare `>` is not JSX
  });

  it("ignores JSX that lives in a comment or a string — the graphHealth shape", () => {
    // MEASURED on the real file. graphHealth.ts is a JSX-free analysis module that TALKS ABOUT
    // components, so it carries `<Name/>` in a doc comment and `(<${c.name}/>)` in a template literal.
    // Sniffing the raw text called it tsx, and it still failed to build:
    // `The character ">" is not valid inside a JSX element`. The sniff has to read code, not prose.
    const commentOnly = "// whose only rendered element is itself, <Name/> — self-referential\nexport const a = 1;";
    expect(loaderFor("features/designs/lib/graphHealth", commentOnly)).toBe("ts");

    const templateOnly = "export const why = (n: string) => `${n} only renders itself (<${n}/>)`;";
    expect(loaderFor("features/designs/lib/graphHealth", templateOnly)).toBe("ts");

    const blockComment = "/* renders <div></div> */\nexport const b: number = 2;";
    expect(loaderFor("mod", blockComment)).toBe("ts");

    const quoted = "export const s = \"</div>\";\nexport const t = '<br/>';";
    expect(loaderFor("mod", quoted)).toBe("ts");

    // …but an escaped quote must not swallow the rest of the file and hide REAL JSX after it.
    const escaped = "const q = \"a\\\"b\";\nexport const C = () => <div>hi</div>;";
    expect(loaderFor("mod", escaped)).toBe("tsx");
  });

  it("an extensionless key is NEVER jsx — the #3549 guard, restated", () => {
    for (const src of [GENERIC_ARROW, "import type { X } from 'y';", "export const C = () => <p>a</p>;"]) {
      expect(loaderFor("some/module", src)).not.toBe("jsx");
    }
  });
});

describe("componentBundle — the import.meta.glob shim (#81, designer request)", () => {
  // `import.meta.glob` is a VITE BUILD MACRO with no esbuild equivalent, so in a preview build it is
  // undefined and calling it throws `(intermediate value).glob is not a function` BEFORE the component
  // function runs. `agentProfiles.ts` calls it at MODULE TOP LEVEL and `store/index.ts` imports that,
  // so every component reaching `useAppStore` inherited the crash — 44 of the store's 49 render-errors.
  //
  // esbuild-wasm cannot initialise under jsdom, so these cover the WIRING; the transform itself was
  // verified against the real esbuild-wasm over the real `agentProfiles.ts` (see the change record).

  it("routes import.meta.glob to a shim the banner declares", () => {
    expect(PREVIEW_DEFINE["import.meta.glob"]).toBe(PREVIEW_GLOB_SHIM);
    expect(PREVIEW_GLOB_BANNER).toContain(PREVIEW_GLOB_SHIM);
    // The define VALUE must be a bare identifier: esbuild rejects a function literal outright with
    // `Invalid define value (must be an entity name or JS literal)`, which is why the banner exists.
    expect(PREVIEW_GLOB_SHIM).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
  });

  it("the shim RETURNS an empty object rather than throwing or being undefined", () => {
    // Evaluate the banner exactly as esbuild prepends it, then call what it declared.
    const shim = new Function(`${PREVIEW_GLOB_BANNER} return ${PREVIEW_GLOB_SHIM};`)() as
      (pattern: string, opts?: unknown) => Record<string, unknown>;
    expect(typeof shim).toBe("function");
    // Called with the real call's shape — a pattern plus Vite's options bag.
    expect(shim("@data/roles/*.json", { eager: true })).toEqual({});
    // The consuming code does `Object.values(...)` / `Object.keys(...)` on the result, so an empty
    // OBJECT is what keeps the module body running; undefined or null would throw one line later.
    expect(Object.values(shim("@data/a/*.png", { eager: true, query: "?url" }))).toEqual([]);
  });

  it("names a shim unlikely to collide with anything in a bundled module", () => {
    expect(PREVIEW_GLOB_SHIM.startsWith("__bsc")).toBe(true);
  });
});

describe("componentBundle — the ?raw / ?url import rule (#85, designer request)", () => {
  // The SECOND Vite-only import feature. `import md from "@data/fleet/worker-protocol.md?raw"` is valid
  // production code Vite expands at build time; the suffixed specifier matched no branch of the resolver,
  // so it fell to the universal stub and the default export was a Proxy where the importer's contract
  // promised a STRING. `persona.ts` imports three protocol files that way, `runtimeFault.ts` four templates.
  //
  // esbuild-wasm cannot initialise under jsdom, so these cover the RULE; that a real build produces a real
  // string is asserted in Chromium by `e2e/previewShims.spec.ts`.

  it("recognises the ?raw and ?url suffixes and nothing else", () => {
    expect(rawImportSpec("@data/fleet/worker-protocol.md?raw")).toEqual({ base: "@data/fleet/worker-protocol.md", query: "raw" });
    expect(rawImportSpec("@/assets/logo.svg?url")).toEqual({ base: "@/assets/logo.svg", query: "url" });
    // A plain specifier is untouched — every other resolver branch must still see it.
    expect(rawImportSpec("@/store")).toBeNull();
    expect(rawImportSpec("react")).toBeNull();
    expect(rawImportSpec("./sibling.ts")).toBeNull();
    // A query that is NOT one of the two is not ours to claim (Vite has many; these are the two we serve).
    expect(rawImportSpec("./worker.ts?worker")).toBeNull();
    expect(rawImportSpec("./a.json?raw&inline")).toBeNull();
  });

  it("emits a module whose DEFAULT export is a string", () => {
    const mod = rawModuleSource("line one\nline two");
    expect(mod).toContain("export default");
    // Round-trip through the actual JS the bundler emits, so an escaping bug cannot pass.
    const value = new Function(mod.replace("export default", "return")) () as unknown;
    expect(value).toBe("line one\nline two");
    // Quotes, backslashes and newlines survive — a markdown protocol file carries all three.
    const tricky = 'a "quoted" \\ path\n`tick` ${notInterpolated}';
    expect(new Function(rawModuleSource(tricky).replace("export default", "return"))()).toBe(tricky);
  });

  it("resolves ?raw to the vendored file's text, and to an EMPTY STRING when it has none", () => {
    const files = { "data/protocol.md": "the protocol", "shared/x.ts": "export const x = 1;" };
    expect(rawModuleText(files, "@/data/protocol.md?raw")).toBe("the protocol");
    expect(rawModuleText(files, "data/protocol.md?raw")).toBe("the protocol");
    // THE DEGRADATION THAT MATTERS: not a stub, not undefined — the empty value of the RIGHT TYPE, so an
    // importer's `.trim()` / `.split()` returns an empty result instead of answering from a Proxy.
    expect(rawModuleText(files, "@data/fleet/worker-protocol.md?raw")).toBe("");
    expect(typeof rawModuleText(files, "@data/fleet/worker-protocol.md?raw")).toBe("string");
    // `?url` yields its own base specifier — still a string, which is the part callers depend on.
    expect(rawModuleText(files, "@/assets/logo.svg?url")).toBe("@/assets/logo.svg");
    // A non-raw specifier never reaches this function, and returns empty if it somehow does.
    expect(rawModuleText(files, "@/store")).toBe("");
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

  it("locks the iframe with a CSP that blocks exfiltration + uncurated code (#3696)", () => {
    const doc = buildComponentSrcDoc("X");
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain("connect-src 'none'");               // a compromised esm.sh dep can render but can't phone home
    expect(doc).toContain("script-src 'unsafe-inline' https://esm.sh"); // only the inlined bundle + curated CDN
  });

  it("defaults to the shared import-map + dark theme", () => {
    const doc = buildComponentSrcDoc("X");
    expect(doc).toContain('data-theme="dark"');
    expect(doc).toContain(COMPONENT_IMPORTMAP["react"]);
  });

  it("puts the theme overrides in a DEDICATED swappable style, separate from injectedCss (#3556)", () => {
    const doc = buildComponentSrcDoc("X", { injectedCss: ".app{color:red}", themeCss: ":root{--accent:#0f0}", theme: "dark" });
    expect(doc).toContain('<style id="__bsc_theme">:root{--accent:#0f0}</style>'); // the swappable theme style
    expect(doc).toContain(".app{color:red}");                                      // app CSS in its own style
    expect(doc).toContain("__bsc_theme");                                          // the live-apply handler
  });

  it("the srcdoc handler applies a theme message LIVE — data-theme + the style text (#3556)", () => {
    const doc = buildComponentSrcDoc("X", { themeCss: ":root{--a:1}", theme: "dark" });
    const script = /<script>([\s\S]*?__bsc_theme[\s\S]*?)<\/script>/.exec(doc)?.[1];
    expect(script).toBeTruthy();
    document.documentElement.setAttribute("data-theme", "dark");
    const style = document.createElement("style");
    style.id = "__bsc_theme";
    style.textContent = ":root{--a:1}";
    document.head.appendChild(style);
    (0, eval)(script!); // installs the message listener (+ harmless error listeners)
    window.dispatchEvent(new MessageEvent("message", { data: { __bsc_theme: { base: "light", css: ":root{--a:2}" } } }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(style.textContent).toBe(":root{--a:2}");
    style.remove();
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

  it("inspectEngineScript embeds the navigable names + the fiber/data-attr picker; empty ⇒ empty", () => {
    expect(inspectEngineScript([])).toBe("");
    const s = inspectEngineScript(["WorkerBoard", "FleetHealth"]);
    expect(s.startsWith("\n<script>")).toBe(true);
    expect(s).toContain('["WorkerBoard","FleetHealth"]');   // the navigable child set (the component's composes)
    expect(s).toContain("__reactFiber$");                    // primary path: React fiber-walk (unminified names)
    expect(s).toContain("data-bsc-comp");                    // fallback: explicit tag (non-React / e2e seam)
    expect(s).toContain("__navigate");                       // posts the chosen child to the host on Alt-click
    expect(s).toContain("elementFromPoint");                 // hit-tests under the cursor
  });

  it("buildComponentSrcDoc adds the Alt-hold inspect layer only when `inspect` names are passed (else unchanged)", () => {
    expect(buildComponentSrcDoc("X", {})).not.toContain("__navigate");
    const doc = buildComponentSrcDoc("X", { inspect: ["Card"] });
    expect(doc).toContain("__navigate");
    expect(doc).toContain('["Card"]');
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

describe("loaderFor: a record id is not a filename (#103)", () => {
  const JSX = 'export function Fallback() { return <Row className="mono">loading…</Row>; }';

  it("loads a .ts-keyed module containing JSX as tsx", () => {
    // `@/app/lazyWorkspaces` is served by the graph-impl record `lazy-workspaces.ts`, and that `.ts` is
    // part of an ID. Loaded as `ts`, its `<Row className=…>` parses as a type assertion and esbuild
    // says `Expected ">" but found "className"` — a syntax error against source that has none, which
    // is exactly what designer request #103 spent its time trying to locate in the file.
    expect(loaderFor("app/lazyWorkspaces.ts", JSX)).toBe("tsx");
    expect(loaderFor("lazy-workspaces.ts", JSX)).toBe("tsx");
  });

  it("still loads a .ts module WITHOUT JSX as ts, so type assertions keep working", () => {
    // The one thing `.ts` offers that `.tsx` does not. `<T>expr` has neither `</` nor `/>`, so the
    // sniff cannot upgrade it — if it did, this would stop compiling.
    expect(loaderFor("x.ts", "const n = <number>value;")).toBe("ts");
    expect(loaderFor("x.ts", "export const add = (a: number, b: number) => a + b;")).toBe("ts");
    expect(loaderFor("x.ts", "export function first<T>(xs: T[]): T { return xs[0]; }")).toBe("ts");
  });

  it("does not mistake a tag inside a string or comment for JSX", () => {
    // The sniff runs on source with strings and comments removed, or every module documenting a tag
    // would be upgraded — and the upgrade is only safe because it is rare and evidenced.
    expect(loaderFor("x.ts", 'const doc = "use <Row /> here";')).toBe("ts");
    expect(loaderFor("x.ts", "// renders <Row />\nexport const n = 1;")).toBe("ts");
  });

  it("leaves the explicit extensions alone", () => {
    expect(loaderFor("x.tsx", "export const n = 1;")).toBe("tsx");
    expect(loaderFor("x.js", JSX)).toBe("jsx");
    expect(loaderFor("x.jsx", JSX)).toBe("jsx");
    // No extension at all — the pre-existing last-resort sniff, unchanged.
    expect(loaderFor("bare", JSX)).toBe("tsx");
    expect(loaderFor("bare", "export const n = 1;")).toBe("ts");
  });
});

describe("@data JSON in a preview (#105)", () => {
  it("recognises a packaged-data JSON import and nothing else", () => {
    expect(dataJsonSpec("@data/console/models.json")).toBe(true);
    expect(dataJsonSpec("@data/ui/themes.json")).toBe(true);
    expect(dataJsonSpec("@data/fleet/worker-protocol.md")).toBe(false); // not JSON
    expect(dataJsonSpec("@/app/console/lib/models")).toBe(false);       // first-party code
    expect(dataJsonSpec("react")).toBe(false);
  });

  it("serves the REAL packaged file, so a preview shows real data and not a stand-in", () => {
    // The exact import in `models.ts` that made PaneAt/PaneMenu/PaneShell throw.
    const mod = dataJsonModule("@data/console/models.json");
    expect(mod.startsWith("export default ")).toBe(true);
    const value = JSON.parse(mod.replace(/^export default /, "").replace(/;\s*$/, ""));
    expect(Array.isArray(value)).toBe(true);
    expect(value.length).toBeGreaterThan(0);
    // It is an ARRAY of things with ids — which is all `MODELS.map((m) => m.id)` needs to survive.
    expect(value.every((m: { id?: unknown }) => typeof m.id === "string")).toBe(true);
  });

  it("makes a MISSING specifier name itself instead of failing three frames away", () => {
    // The whole improvement over the universal stub: a Proxy answers every property and the failure
    // surfaces as `MODEL_IDS.find` somewhere else. This says WHICH specifier was missing, when touched.
    // `react-ui.json` has no top-level static importer (the kit artifact arrives as source/runtime
    // params instead), so it stays a genuine "nothing registered this" case, unlike algorithms.json below.
    const mod = dataJsonModule("@data/components/react-ui.json"); // deliberately excluded — 4.80 MB
    expect(mod).toContain("is not vendored into this preview");
    expect(mod).toContain("@data/components/react-ui.json");
    expect(mod).not.toContain("export default {}");
  });

  it("excludes the two giant directories, but resolves either — one to the real vendored default, one honestly empty", () => {
    // Bounded on purpose: vendoring everything imported would be 8.88 MB, and 8.7 MB of it is these two.
    for (const kept of ["@data/ui/themes.json", "@data/teams/departments.json", "@data/mcp/catalog.json"]) {
      expect(dataJsonModule(kept), `${kept} must be vendored`).toContain("export default ");
    }
    // react-ui.json: nothing imports it as a static ES module, so excluding it is a genuine miss.
    expect(dataJsonModule("@data/components/react-ui.json")).toContain("is not vendored");
  });

  describe("algorithms.json's honest empty default (#106)", () => {
    // `features/algorithms/lib/knowledge.ts` does `import RAW from "@data/knowledge/algorithms.json"`
    // at MODULE TOP LEVEL, and `store/index.ts` composes the algorithms slice — so the import is
    // reachable from `@/store` itself, not just from Algorithms feature UI. Excluding it with the
    // throwing-proxy fallback broke every component that merely calls `useAppStore` (103 of 138
    // render-doctor findings: StatusBar, PaneMenu/PaneShell, TeamsInspector, none of them rendering
    // anything algorithm-related). This is the same class of fix as the import.meta.glob shim (#81,
    // returns `{}`) and the ?raw shim (#85, returns `""`): the honest degradation is the empty value of
    // the right SHAPE.
    it("resolves to a real module rather than a throwing proxy", () => {
      const mod = dataJsonModule("@data/knowledge/algorithms.json");
      expect(mod.startsWith("export default ")).toBe(true);
      expect(mod).not.toContain("is not vendored");
      expect(mod).not.toContain("new Proxy");
    });

    it("is shaped exactly as knowledge.ts's own buildKnowledge already tolerates — {implementations: []}", () => {
      const mod = dataJsonModule("@data/knowledge/algorithms.json");
      const value = JSON.parse(mod.replace(/^export default /, "").replace(/;\s*$/, ""));
      expect(value).toEqual({ implementations: [] });
      // A component that DOES render Algorithms feature UI in a preview degrades to an empty knowledge
      // graph rather than crashing every OTHER component that merely touches the store.
      expect(Array.isArray(value.implementations)).toBe(true);
      expect(value.implementations).toHaveLength(0);
    });
  });
});
