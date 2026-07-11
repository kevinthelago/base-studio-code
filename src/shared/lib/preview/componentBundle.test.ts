import { describe, it, expect } from "vitest";
import { compileAnimationsCss, componentAnimations } from "@/shared/ui/kit";
import {
  resolveMemPath, lookupMem, buildComponentSrcDoc, COMPONENT_IMPORTMAP, COMPONENT_EXTERNALS,
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

  it("carries an authored component's compiled motion into the iframe, reduced-motion-guarded (#2870)", () => {
    // The full preview path: compile the record's animations → inject the CSS + apply the class on #root.
    const comp = { name: "Card", animations: [{ name: "fade-in", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } } }] };
    const defs = componentAnimations([comp]);
    const doc = buildComponentSrcDoc("X", {
      injectedCss: compileAnimationsCss(defs),
      rootClass: defs.map((d) => `${d.component}-anim-${d.name}`).join(" "),
    });
    expect(doc).toContain("@keyframes bsc-card-fade-in");                    // the keyframes reach the iframe
    expect(doc).toContain("@media (prefers-reduced-motion: no-preference)"); // motion suppressed for reduced-motion viewers
    expect(doc).toContain('<div id="root" class="card-anim-fade-in">');       // #root carries the applying class → it plays
  });
});

describe("componentBundle — externals", () => {
  it("derives the external set from the import-map keys (pinned to esm.sh)", () => {
    expect(COMPONENT_EXTERNALS).toEqual(Object.keys(COMPONENT_IMPORTMAP));
    expect(COMPONENT_EXTERNALS).toContain("react");
    for (const url of Object.values(COMPONENT_IMPORTMAP)) expect(url).toMatch(/^https:\/\/esm\.sh\//);
  });
});
