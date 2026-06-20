import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerPipeline, dispatchPipelineCommand, hasPipelineModule, isPipelineCommand,
  _resetPipelineModules, PIPELINE_COMMANDS, type PipelineCommand,
} from "../screens/planner/grading/pipelineCommands";

describe("pipelineCommands — bus", () => {
  beforeEach(() => _resetPipelineModules());

  it("routes a command to the registered module with the project + args", async () => {
    const seen: { cmd: PipelineCommand; key: string; args: Record<string, string> }[] = [];
    registerPipeline({
      id: "vue", command: (cmd, ctx) => { seen.push({ cmd, key: ctx.projectKey, args: ctx.args }); },
    });

    const r = await dispatchPipelineCommand("vue", "run", { projectKey: "p1", args: { variant: "button" } });
    expect(r.ok).toBe(true);
    expect(seen).toEqual([{ cmd: "run", key: "p1", args: { variant: "button" } }]);
  });

  it("awaits async handlers", async () => {
    let done = false;
    registerPipeline({ id: "slow", command: async () => { await Promise.resolve(); done = true; } });
    await dispatchPipelineCommand("slow", "save", { projectKey: "p", args: {} });
    expect(done).toBe(true);
  });

  it("an unknown pipeline resolves to a structured failure (never throws)", async () => {
    const r = await dispatchPipelineCommand("nope", "run", { projectKey: "p", args: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no pipeline module/);
  });

  it("a throwing handler is caught and reported", async () => {
    registerPipeline({ id: "boom", command: () => { throw new Error("kaboom"); } });
    const r = await dispatchPipelineCommand("boom", "confirm", { projectKey: "p", args: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/kaboom/);
  });

  it("last registration wins (idempotent replace)", async () => {
    let which = "";
    registerPipeline({ id: "x", command: () => { which = "first"; } });
    registerPipeline({ id: "x", command: () => { which = "second"; } });
    await dispatchPipelineCommand("x", "run", { projectKey: "p", args: {} });
    expect(which).toBe("second");
    expect(hasPipelineModule("x")).toBe(true);
  });

  it("isPipelineCommand validates the command set", () => {
    expect(PIPELINE_COMMANDS).toContain("run");
    expect(isPipelineCommand("confirm")).toBe(true);
    expect(isPipelineCommand("frobnicate")).toBe(false);
  });
});

describe("pipelineCommands — render-preview module", () => {
  it("render-preview registers a command module on import", async () => {
    // Mock the bundler so importing renderPreview's transitive deps is jsdom-safe.
    vi.resetModules();
    vi.doMock("../screens/planner/previewBundle", () => ({
      bundleSkeleton: vi.fn().mockResolvedValue("BUNDLE_JS"),
      buildPreviewSrcDoc: (js: string) => `<html><body>${js}</body></html>`,
    }));
    const { RENDER_PREVIEW_ID } = await import("../screens/planner/renderPreview");
    const { hasPipelineModule: has } = await import("../screens/planner/grading/pipelineCommands");
    expect(has(RENDER_PREVIEW_ID)).toBe(true);
  });
});
