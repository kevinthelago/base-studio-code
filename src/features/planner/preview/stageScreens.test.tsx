import { describe, it, expect, vi } from "vitest";

// stageScreens imports PlanPreviewPane → renderPreview → previewBundle, whose
// esbuild-wasm module load fails under jsdom. Mock it so the registry imports clean.
vi.mock("../preview/previewBundle", () => ({
  bundleSkeleton: vi.fn().mockResolvedValue("BUNDLE_JS"),
  buildPreviewSrcDoc: (js: string) => `<html><body>${js}</body></html>`,
}));

import { stageScreen, hasStageScreen, registerStageScreen } from "./stageScreens";
import { RENDER_PREVIEW_ID } from "../preview/renderPreview";

describe("stageScreens registry", () => {
  it("render-preview declares a second screen", () => {
    expect(hasStageScreen(RENDER_PREVIEW_ID)).toBe(true);
    expect(stageScreen(RENDER_PREVIEW_ID)).toBeTypeOf("function");
  });

  it("a stage module with no second screen resolves to undefined", () => {
    expect(hasStageScreen("grade-plan")).toBe(false);
    expect(stageScreen("no-such-pipeline")).toBeUndefined();
  });

  it("an external pipeline can register its own second screen", () => {
    const Dummy = () => null;
    registerStageScreen("ext-dep-graph", Dummy);
    expect(hasStageScreen("ext-dep-graph")).toBe(true);
    expect(stageScreen("ext-dep-graph")).toBe(Dummy);
  });
});
