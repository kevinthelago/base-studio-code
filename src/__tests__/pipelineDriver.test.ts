import { describe, it, expect } from "vitest";
import {
  stageRefName, parseStageRefName, emptyRegistry, startPipeline, driveOnEvent,
  type PipelineRegistry,
} from "../lib/pipelineDriver";
import { PIPELINE_PRESETS } from "../lib/pipeline";
import type { CoordEvent } from "../lib/coordination";

const P = PIPELINE_PRESETS["implement-test-review-integrate"];

/** A #199 landed/failed event for a pipeline stage. */
function ev(kind: "landed" | "failed", item: string, stage: string): CoordEvent {
  return { type: kind, ref: { kind: "contract", name: stageRefName(item, stage) }, at: 0 } as CoordEvent;
}

describe("stage ref encoding", () => {
  it("round-trips item + stage (incl. a #-item)", () => {
    expect(parseStageRefName(stageRefName("#42", "build-test"))).toEqual({ item: "#42", stage: "build-test" });
    expect(parseStageRefName("nope")).toBeNull();
    expect(parseStageRefName("pipe:onlyitem")).toBeNull();
  });
});

describe("driveOnEvent", () => {
  function started(): PipelineRegistry {
    return startPipeline(emptyRegistry(), P, "#1").registry;
  }

  it("a landed event for the current stage advances the run + returns the next launch", () => {
    const reg = started(); // at implement
    const { registry, result } = driveOnEvent(reg, ev("landed", "#1", "implement"));
    expect(result?.kind).toBe("launch");
    if (result?.kind === "launch") expect(result.launch.stage).toBe("build-test");
    expect(registry.runs["#1"].state.stage).toBe("build-test");
  });

  it("a failed event at build-test routes to fix", () => {
    let reg = started();
    reg = driveOnEvent(reg, ev("landed", "#1", "implement")).registry; // → build-test
    const { result } = driveOnEvent(reg, ev("failed", "#1", "build-test"));
    expect(result?.kind).toBe("launch");
    if (result?.kind === "launch") expect(result.launch.stage).toBe("fix");
  });

  it("ignores events for the wrong stage, unknown items, or non-stage refs", () => {
    const reg = started(); // at implement
    expect(driveOnEvent(reg, ev("landed", "#1", "review")).result).toBeUndefined();   // not current stage
    expect(driveOnEvent(reg, ev("landed", "#999", "implement")).result).toBeUndefined(); // unknown item
    expect(driveOnEvent(reg, { type: "merged", ref: { kind: "issue", number: 5 }, at: 0 }).result).toBeUndefined();
  });

  it("drives a full run to done across events", () => {
    let reg = started();
    for (const stage of ["implement", "build-test", "review", "integrate"]) {
      reg = driveOnEvent(reg, ev("landed", "#1", stage)).registry;
    }
    expect(reg.runs["#1"].state.status).toBe("done");
  });
});
