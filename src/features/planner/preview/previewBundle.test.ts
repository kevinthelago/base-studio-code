import { describe, it, expect } from "vitest";
import {
  resolveMemPath, lookupMem, bootstrapSource, buildPreviewSrcDoc, DEFAULT_IMPORTMAP, PREVIEW_EXTERNALS,
} from "./previewBundle";
import { lookupMem as sharedLookupMem } from "@/shared/lib/preview/componentBundle";

describe("previewBundle — resolveMemPath", () => {
  it("resolves a sibling import from the entry", () => {
    expect(resolveMemPath("__preview_bootstrap__.jsx", "./LoginScreen.jsx")).toBe("LoginScreen.jsx");
  });
  it("resolves nested + parent paths", () => {
    expect(resolveMemPath("screens/Login.jsx", "./parts/Field.jsx")).toBe("screens/parts/Field.jsx");
    expect(resolveMemPath("screens/Login.jsx", "../shared/Btn.jsx")).toBe("shared/Btn.jsx");
  });
});

describe("previewBundle — lookupMem", () => {
  const files = { "Login.jsx": "a", "parts/Field.tsx": "b", "ui/index.jsx": "c" };
  it("finds by exact key and by extension fallback", () => {
    expect(lookupMem(files, "Login.jsx")?.loader).toBe("jsx");
    expect(lookupMem(files, "Login")?.contents).toBe("a");
    expect(lookupMem(files, "parts/Field")?.loader).toBe("tsx");
    expect(lookupMem(files, "ui")?.contents).toBe("c"); // index resolution
  });

  // #79 — THE TWO BUNDLERS MUST AGREE. They are parallel copies, and their extensionless defaults had
  // drifted APART: the shared one was corrected to tsx under #3549 while this one still said jsx, so a
  // TypeScript module reached from the planner preview failed on `import type` where the same module
  // built fine from the component preview. They now share one `loaderFor`, and this pins that.
  it("picks the same loader as the shared bundler for the same input", () => {
    const cases: Record<string, string> = {
      // The reported construct: a generic arrow in a JSX-free module — the case that failed under BOTH.
      "features/planner/lib/deployEnv": "const clone = <T>(v: T): T => structuredClone(v);\nexport { clone };",
      "features/designs/lib/graphHealth": "import type { X } from 'y';\nexport const n: number = 2 > 1 ? 1 : 0;",
      "Card": "export const C = () => <div>hi</div>;",
      "boot.jsx": "export const B = 1;",
      "typed.ts": "export const T: number = 1;",
      "widget.tsx": "export const W = () => <p>x</p>;",
    };
    for (const [key, src] of Object.entries(cases)) {
      const mine = lookupMem({ [key]: src }, key)?.loader;
      const theirs = sharedLookupMem({ [key]: src }, key)?.loader;
      expect(mine, `loader for ${key}`).toBe(theirs);
    }
    // And specifically: the reported module is `ts`, which neither bundler could produce before.
    expect(lookupMem({ deployEnv: "const c = <T>(v: T): T => v;" }, "deployEnv")?.loader).toBe("ts");
  });
  it("returns null for a missing module", () => {
    expect(lookupMem(files, "Nope")).toBeNull();
  });
});

describe("previewBundle — bootstrapSource", () => {
  it("mounts the screen's default export via react-dom/client", () => {
    const src = bootstrapSource("LoginScreen.jsx");
    expect(src).toMatch(/react-dom\/client/);
    expect(src).toMatch(/import Screen from "\.\/LoginScreen\.jsx"/);
    expect(src).toMatch(/createRoot/);
  });
});

describe("previewBundle — buildPreviewSrcDoc", () => {
  it("embeds the import-map, the bundle, and the ready/error signals", () => {
    const doc = buildPreviewSrcDoc("/*BUNDLE*/console.log(1)");
    expect(doc).toContain("importmap");
    expect(doc).toContain(DEFAULT_IMPORTMAP["react"]);   // esm.sh react
    expect(doc).toContain("/*BUNDLE*/");
    expect(doc).toContain('__preview');                   // ready/error postMessage
    expect(doc).toContain('id="root"');
    expect(doc).toContain('http-equiv="Content-Security-Policy"'); // #3696 — same iframe lockdown
    expect(doc).toContain("connect-src 'none'");
  });
  it("react + three are in the externals list", () => {
    expect(PREVIEW_EXTERNALS).toContain("react");
    expect(PREVIEW_EXTERNALS).toContain("@react-three/fiber");
  });

  // Guard for the externalized pins (@data/ui/preview-importmap.json, #2419) — ONE source: the
  // externals derive from the import-map keys, and every pin resolves to esm.sh.
  it("the externals ARE the import-map keys, each pinned to an https esm.sh URL", () => {
    expect(PREVIEW_EXTERNALS).toEqual(Object.keys(DEFAULT_IMPORTMAP));
    for (const url of Object.values(DEFAULT_IMPORTMAP)) expect(url).toMatch(/^https:\/\/esm\.sh\//);
  });
});
