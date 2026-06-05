import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../screens/projects/previewBundle", () => ({
  bundleSkeleton: vi.fn().mockResolvedValue("BUNDLE_JS"),
  buildPreviewSrcDoc: (js: string) => `<html><body>${js}</body></html>`,
}));

import { resolveEntry, renderPreviewHandler, dispatchRenderPreview, RENDER_PREVIEW_ID } from "../screens/projects/renderPreview";
import { hasPipelineHandler } from "../screens/projects/pipelineRuntime";
import { useAppStore } from "../store";

const ctx = (over: Record<string, unknown> = {}) => ({
  projectKey: "proj", stageId: "ui", artifacts: { "Login.jsx": "x" }, trigger: "manual" as const, ...over,
});

describe("renderPreview — resolveEntry", () => {
  it("prefers an explicit entry that exists, else the first source file", () => {
    const files = { "a.jsx": "1", "b.tsx": "2", "readme.md": "3" };
    expect(resolveEntry(files, "b.tsx")).toBe("b.tsx");
    expect(resolveEntry(files, "missing.jsx")).toBe("a.jsx");
    expect(resolveEntry(files)).toBe("a.jsx");
    expect(resolveEntry({ "x.md": "1" })).toBeNull();
  });
});

describe("renderPreview — handler", () => {
  it("registers itself into the engine on import", () => {
    expect(hasPipelineHandler(RENDER_PREVIEW_ID)).toBe(true);
  });

  it("bundles + returns a preview output (mode default 2d)", async () => {
    const r = await renderPreviewHandler(ctx(), {} as never);
    expect(r.status).toBe("ok");
    expect((r.output as { srcDoc: string; mode: string }).srcDoc).toContain("BUNDLE_JS");
    expect((r.output as { mode: string }).mode).toBe("2d");
  });

  it("honors mode=3d and fails with no screen file", async () => {
    expect((await renderPreviewHandler(ctx({ mode: "3d" }), {} as never)).output).toMatchObject({ mode: "3d" });
    const fail = await renderPreviewHandler(ctx({ artifacts: { "x.md": "1" } }), {} as never);
    expect(fail.status).toBe("fail");
  });
});

describe("renderPreview — dispatch writes the store", () => {
  beforeEach(() => useAppStore.setState({ stagePreview: {}, stagePipelineRuns: {} }));

  it("writes the bundled srcdoc + an ok run state", async () => {
    await dispatchRenderPreview({ projectKey: "proj", artifacts: { "Login.jsx": "x" }, entry: "Login.jsx", mode: "2d" });
    expect(useAppStore.getState().stagePreview["proj"]?.srcDoc).toContain("BUNDLE_JS");
    expect(useAppStore.getState().stagePipelineRuns["proj"][RENDER_PREVIEW_ID].status).toBe("ok");
  });
});
