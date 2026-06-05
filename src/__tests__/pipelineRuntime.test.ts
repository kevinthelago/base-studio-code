import { describe, it, expect, beforeEach } from "vitest";
import {
  registerPipelineHandler, getPipelineHandler, hasPipelineHandler, _resetPipelineHandlers,
  pipelinesForTrigger, runPipeline, isGateBlocked,
  type StageContext, type PipelineRunState,
} from "../screens/projects/pipelineRuntime";
import { mkSection, type Pipeline } from "../screens/projects/blueprints";

function pipe(over: Partial<Pipeline> = {}): Pipeline {
  return { uid: "pl-1", id: "lint-plan", name: "Lint plan", desc: "", suits: ["*"], kind: "builtin", trigger: "on completion", enabled: true, ...over };
}
const ctx: StageContext = { projectKey: "proj", stageId: "structure", artifacts: {}, trigger: "manual" };

beforeEach(() => _resetPipelineHandlers());

describe("pipelineRuntime — registry", () => {
  it("registers and resolves a handler by id", () => {
    const h = () => ({ status: "ok" as const });
    expect(hasPipelineHandler("lint-plan")).toBe(false);
    registerPipelineHandler("lint-plan", h);
    expect(hasPipelineHandler("lint-plan")).toBe(true);
    expect(getPipelineHandler("lint-plan")).toBe(h);
  });
});

describe("pipelineRuntime — pipelinesForTrigger", () => {
  it("returns only enabled pipelines whose trigger matches", () => {
    const ps: Pipeline[] = [
      pipe({ uid: "a", trigger: "on completion", enabled: true }),
      pipe({ uid: "b", trigger: "on completion", enabled: false }),
      pipe({ uid: "c", trigger: "on artifact change", enabled: true }),
    ];
    expect(pipelinesForTrigger(ps, "on completion").map(p => p.uid)).toEqual(["a"]);
    expect(pipelinesForTrigger(ps, "on artifact change").map(p => p.uid)).toEqual(["c"]);
    expect(pipelinesForTrigger(ps, "on section enter")).toEqual([]);
  });
});

describe("pipelineRuntime — runPipeline", () => {
  it("runs the registered handler and returns its result", async () => {
    registerPipelineHandler("lint-plan", () => ({ status: "ok", message: "clean" }));
    const r = await runPipeline(pipe(), ctx);
    expect(r).toEqual({ status: "ok", message: "clean" });
  });

  it("awaits async handlers", async () => {
    registerPipelineHandler("lint-plan", async () => ({ status: "blocked", message: "3 gaps" }));
    expect(await runPipeline(pipe(), ctx)).toEqual({ status: "blocked", message: "3 gaps" });
  });

  it("fails (never throws) when no handler is registered", async () => {
    const r = await runPipeline(pipe({ id: "nope" }), ctx);
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/no handler/);
  });

  it("turns a thrown handler error into a fail result", async () => {
    registerPipelineHandler("lint-plan", () => { throw new Error("boom"); });
    const r = await runPipeline(pipe(), ctx);
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/boom/);
  });

  it("passes the stage context + pipeline through to the handler", async () => {
    let seen: StageContext | null = null;
    registerPipelineHandler("lint-plan", (c) => { seen = c; return { status: "ok" }; });
    await runPipeline(pipe(), { ...ctx, stageId: "ui", artifacts: { "ui.md": "hi" } });
    expect(seen!.stageId).toBe("ui");
    expect(seen!.artifacts["ui.md"]).toBe("hi");
  });
});

describe("pipelineRuntime — isGateBlocked", () => {
  const runs = (m: Record<string, PipelineRunState["status"]>): Record<string, PipelineRunState> =>
    Object.fromEntries(Object.entries(m).map(([k, status]) => [k, { status, lastRun: 1 }]));

  it("blocks when an enabled pipeline's last run is blocked", () => {
    const ps = [pipe({ uid: "a" }), pipe({ uid: "b" })];
    expect(isGateBlocked(ps, runs({ a: "ok", b: "blocked" }))).toBe(true);
  });
  it("does not block on ok/fail/idle or unrun pipelines", () => {
    const ps = [pipe({ uid: "a" }), pipe({ uid: "b" })];
    expect(isGateBlocked(ps, runs({ a: "ok", b: "fail" }))).toBe(false);
    expect(isGateBlocked(ps, {})).toBe(false);
  });
  it("ignores disabled pipelines even if blocked", () => {
    const ps = [pipe({ uid: "a", enabled: false })];
    expect(isGateBlocked(ps, runs({ a: "blocked" }))).toBe(false);
  });
});

// guard: a real catalog pipeline flows through the contract (mkSection builds real Pipelines)
describe("pipelineRuntime — integration with the blueprint model", () => {
  it("runs a pipeline taken from a built section", async () => {
    registerPipelineHandler("render-preview", () => ({ status: "ok" }));
    const sec = mkSection("ui", { pipelines: [["render-preview", "on artifact change", true]] });
    const due = pipelinesForTrigger(sec.pipelines, "on artifact change");
    expect(due).toHaveLength(1);
    expect((await runPipeline(due[0], ctx)).status).toBe("ok");
  });
});
