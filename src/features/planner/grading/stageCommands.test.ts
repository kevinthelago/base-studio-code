import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerStageModule, dispatchStageCommand, hasStageModule, isStageCommand,
  _resetStageModules, STAGE_COMMANDS, type StageCommand,
} from "./stageCommands";

describe("stageCommands — bus", () => {
  beforeEach(() => _resetStageModules());

  it("routes a command to the registered module with the project + args", async () => {
    const seen: { cmd: StageCommand; key: string; args: Record<string, string> }[] = [];
    registerStageModule({
      id: "vue", command: (cmd, ctx) => { seen.push({ cmd, key: ctx.projectKey, args: ctx.args }); },
    });

    const r = await dispatchStageCommand("vue", "run", { projectKey: "p1", args: { variant: "button" } });
    expect(r.ok).toBe(true);
    expect(seen).toEqual([{ cmd: "run", key: "p1", args: { variant: "button" } }]);
  });

  it("awaits async handlers", async () => {
    let done = false;
    registerStageModule({ id: "slow", command: async () => { await Promise.resolve(); done = true; } });
    await dispatchStageCommand("slow", "save", { projectKey: "p", args: {} });
    expect(done).toBe(true);
  });

  it("an unknown stage module resolves to a structured failure (never throws)", async () => {
    const r = await dispatchStageCommand("nope", "run", { projectKey: "p", args: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no stage module/);
  });

  it("a throwing handler is caught and reported", async () => {
    registerStageModule({ id: "boom", command: () => { throw new Error("kaboom"); } });
    const r = await dispatchStageCommand("boom", "confirm", { projectKey: "p", args: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/kaboom/);
  });

  it("last registration wins (idempotent replace)", async () => {
    let which = "";
    registerStageModule({ id: "x", command: () => { which = "first"; } });
    registerStageModule({ id: "x", command: () => { which = "second"; } });
    await dispatchStageCommand("x", "run", { projectKey: "p", args: {} });
    expect(which).toBe("second");
    expect(hasStageModule("x")).toBe(true);
  });

  it("isStageCommand validates the command set", () => {
    expect(STAGE_COMMANDS).toContain("run");
    expect(isStageCommand("confirm")).toBe(true);
    expect(isStageCommand("frobnicate")).toBe(false);
  });
});

describe("stageCommands — render-preview module", () => {
  it("render-preview registers a command module on import", async () => {
    // Mock the bundler so importing renderPreview's transitive deps is jsdom-safe.
    vi.resetModules();
    vi.doMock("../preview/previewBundle", () => ({
      bundleSkeleton: vi.fn().mockResolvedValue("BUNDLE_JS"),
      buildPreviewSrcDoc: (js: string) => `<html><body>${js}</body></html>`,
    }));
    const { RENDER_PREVIEW_ID } = await import("../preview/renderPreview");
    const { hasStageModule: has } = await import("./stageCommands");
    expect(has(RENDER_PREVIEW_ID)).toBe(true);
  });
});
