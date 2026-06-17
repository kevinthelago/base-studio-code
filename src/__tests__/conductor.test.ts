import { describe, it, expect } from "vitest";
import { startRun, conduct, currentLaunch } from "../lib/conductor";
import { WORKFLOW_PRESETS } from "../lib/workflow";

const P = WORKFLOW_PRESETS["implement-test-review-integrate"];

describe("conductor", () => {
  it("starts the item at implement with a worker (code-write) session", () => {
    const { launch } = startRun(P, "#1");
    expect(launch).toMatchObject({ item: "#1", stage: "implement", role: "worker" });
    expect(launch.capability.code).toBe("write");
    expect(launch.seed).toBeUndefined();
  });

  it("success advances to the next stage's role-scoped launch", () => {
    const { run } = startRun(P, "#1");
    const r = conduct(run, "success");
    expect(r.kind).toBe("launch");
    if (r.kind !== "launch") return;
    expect(r.launch.stage).toBe("build-test");
    expect(r.launch.role).toBe("tester");
    expect(r.launch.capability.code).toBe("none"); // tester can't edit
  });

  it("a test failure launches the fix stage, carrying the seed (failure log)", () => {
    const r1 = conduct(startRun(P, "#1").run, "success"); // → build-test
    if (r1.kind !== "launch") throw new Error("expected launch");
    const r2 = conduct(r1.run, "failure", "FAIL: 3 tests red");
    expect(r2.kind).toBe("launch");
    if (r2.kind !== "launch") return;
    expect(r2.launch).toMatchObject({ stage: "fix", role: "worker", seed: "FAIL: 3 tests red" });
  });

  it("drives the happy path to done", () => {
    let run = startRun(P, "#1").run;
    let last = "";
    for (const o of ["success", "success", "success", "success"] as const) {
      const res = conduct(run, o);
      run = res.run;
      last = res.kind;
    }
    expect(last).toBe("done");
    expect(run.state.status).toBe("done");
  });

  it("escalates when implement fails", () => {
    const r = conduct(startRun(P, "#1").run, "failure");
    expect(r.kind).toBe("escalated");
    if (r.kind === "escalated") expect(r.reason).toContain("implement failure");
  });
});

describe("conductor — currentLaunch", () => {
  it("returns the run's current-stage launch, and null when terminal", () => {
    const { run } = startRun(P, "#1");
    expect(currentLaunch(run)?.stage).toBe("implement");
    let r = run;
    for (let i = 0; i < 4; i++) r = conduct(r, "success").run; // → done
    expect(currentLaunch(r)).toBeNull();
  });
});
