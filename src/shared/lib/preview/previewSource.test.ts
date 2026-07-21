import { describe, it, expect } from "vitest";
import { previewRender, isIframeSource, type PreviewSource } from "./previewSource";

describe("previewRender (#2623 — the verify-build → preview-node seam)", () => {
  it("renders a web source as an iframe pointed at its URL", () => {
    expect(previewRender({ kind: "web", url: "http://localhost:4173" })).toEqual({ mode: "iframe", src: "http://localhost:4173" });
  });
  it("renders a bundle (incl. a wgpu/wasm build) as an iframe srcdoc", () => {
    expect(previewRender({ kind: "bundle", srcDoc: "<html>…</html>" })).toEqual({ mode: "iframe", srcDoc: "<html>…</html>" });
  });
  it("renders a native binary as its own external desktop window", () => {
    expect(previewRender({ kind: "native", label: "my-app" })).toEqual({ mode: "external", label: "my-app" });
  });

  it("splits iframe-renderable sources from the native external window", () => {
    const web: PreviewSource = { kind: "web", url: "u" };
    const bundle: PreviewSource = { kind: "bundle", srcDoc: "d" };
    const native: PreviewSource = { kind: "native", label: "app" };
    expect([web, bundle, native].map(isIframeSource)).toEqual([true, true, false]);
  });
});
