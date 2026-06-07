import { describe, it, expect, vi } from "vitest";

// pipelineScreens imports PlanPreviewPane → renderPreview → previewBundle, whose
// esbuild-wasm module load fails under jsdom. Mock it so the registry imports clean.
vi.mock("../screens/projects/previewBundle", () => ({
  bundleSkeleton: vi.fn().mockResolvedValue("BUNDLE_JS"),
  buildPreviewSrcDoc: (js: string) => `<html><body>${js}</body></html>`,
}));

import { pipelineScreen, hasPipelineScreen, registerPipelineScreen } from "../screens/projects/pipelineScreens";
import { RENDER_PREVIEW_ID } from "../screens/projects/renderPreview";

describe("pipelineScreens registry", () => {
  it("render-preview declares a second screen", () => {
    expect(hasPipelineScreen(RENDER_PREVIEW_ID)).toBe(true);
    expect(pipelineScreen(RENDER_PREVIEW_ID)).toBeTypeOf("function");
  });

  it("a pipeline with no second screen resolves to undefined", () => {
    expect(hasPipelineScreen("grade-plan")).toBe(false);
    expect(pipelineScreen("no-such-pipeline")).toBeUndefined();
  });

  it("an external pipeline can register its own second screen", () => {
    const Dummy = () => null;
    registerPipelineScreen("ext-dep-graph", Dummy);
    expect(hasPipelineScreen("ext-dep-graph")).toBe(true);
    expect(pipelineScreen("ext-dep-graph")).toBe(Dummy);
  });
});
