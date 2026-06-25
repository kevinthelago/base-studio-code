import { describe, it, expect } from "vitest";
import {
  resolveMemPath, lookupMem, bootstrapSource, buildPreviewSrcDoc, DEFAULT_IMPORTMAP, PREVIEW_EXTERNALS,
} from "./previewBundle";

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
  });
  it("react + three are in the externals list", () => {
    expect(PREVIEW_EXTERNALS).toContain("react");
    expect(PREVIEW_EXTERNALS).toContain("@react-three/fiber");
  });
});
