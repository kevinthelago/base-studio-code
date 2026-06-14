import { describe, it, expect } from "vitest";
import { evalGate, evalRequirement, gateApplies, gateReasons, type StageGate } from "../screens/projects/stageGate";

describe("stageGate — evalRequirement", () => {
  it("boolean target matches identity; missing reads as false", () => {
    expect(evalRequirement({ signal: "ok", target: true }, { ok: true })).toEqual({ pass: true, progress: 1 });
    expect(evalRequirement({ signal: "ok", target: true }, {})).toEqual({ pass: false, progress: 0 });
    expect(evalRequirement({ signal: "ok", target: false }, { ok: false })).toEqual({ pass: true, progress: 1 });
  });

  it("numeric target compares with the default >= and reports partial progress", () => {
    expect(evalRequirement({ signal: "n", target: 4 }, { n: 4 })).toEqual({ pass: true, progress: 1 });
    expect(evalRequirement({ signal: "n", target: 4 }, { n: 2 })).toEqual({ pass: false, progress: 0.5 });
    expect(evalRequirement({ signal: "n", target: 1 }, { n: 0 })).toEqual({ pass: false, progress: 0 });
  });

  it("ratio (`of`) progress is num/denom and fails when denom is 0", () => {
    expect(evalRequirement({ signal: "a", of: "t" }, { a: 2, t: 4 })).toEqual({ pass: false, progress: 0.5 });
    expect(evalRequirement({ signal: "a", of: "t" }, { a: 4, t: 4 })).toEqual({ pass: true, progress: 1 });
    // total 0 ⇒ not vacuously complete (this is the "total > 0" guard)
    expect(evalRequirement({ signal: "a", of: "t" }, { a: 0, t: 0 })).toEqual({ pass: false, progress: 0 });
  });
});

describe("stageGate — evalGate", () => {
  it("an empty/absent gate is vacuously complete", () => {
    expect(evalGate(undefined, {})).toEqual({ done: true, fraction: 1 });
    expect(evalGate({ require: [] }, {})).toEqual({ done: true, fraction: 1 });
  });

  it("AND of requirements; fraction is the weighted average of progress", () => {
    const gate: StageGate = { require: [
      { signal: "phasesConfirmed", target: true },
      { signal: "issueCount", target: 1 },
    ] };
    expect(evalGate(gate, { phasesConfirmed: true, issueCount: 0 })).toEqual({ done: false, fraction: 0.5 });
    expect(evalGate(gate, { phasesConfirmed: true, issueCount: 3 })).toEqual({ done: true, fraction: 1 });
  });

  it("a weight-0 requirement must pass but contributes no fill", () => {
    const gate: StageGate = { require: [
      { signal: "coreConfirmed", target: true, weight: 0 },
      { signal: "topicsResolved", of: "topicsTotal" },
    ] };
    // core not confirmed blocks done, but fill follows only the ratio requirement.
    expect(evalGate(gate, { coreConfirmed: false, topicsResolved: 3, topicsTotal: 4 }))
      .toEqual({ done: false, fraction: 0.75 });
    expect(evalGate(gate, { coreConfirmed: true, topicsResolved: 4, topicsTotal: 4 }))
      .toEqual({ done: true, fraction: 1 });
  });
});

describe("stageGate — gateApplies", () => {
  it("absent rule always applies; present rule is evaluated", () => {
    expect(gateApplies(undefined, {})).toBe(true);
    expect(gateApplies({ signal: "requiresUi", target: true }, { requiresUi: true })).toBe(true);
    expect(gateApplies({ signal: "requiresUi", target: true }, { requiresUi: false })).toBe(false);
  });
});

describe("stageGate — gateReasons (#805)", () => {
  const gate: StageGate = { require: [
    { signal: "coreConfirmed", target: true, weight: 0, label: "confirm the core files" },
    { signal: "topicsResolved", of: "topicsTotal", label: "resolve the discovery topics" },
    { signal: "issueCount", target: 3, label: "generate agent-ready issues" },
  ] };

  it("reports per-requirement pass + a progress detail; filter !pass for what's missing", () => {
    const reasons = gateReasons(gate, { coreConfirmed: false, topicsResolved: 3, topicsTotal: 5, issueCount: 3 });
    expect(reasons).toEqual([
      { label: "confirm the core files", pass: false, detail: undefined },
      { label: "resolve the discovery topics", pass: false, detail: "3 of 5" },
      { label: "generate agent-ready issues", pass: true, detail: "3 / 3" },
    ]);
    const missing = reasons.filter((r) => !r.pass).map((r) => r.label);
    expect(missing).toEqual(["confirm the core files", "resolve the discovery topics"]);
  });

  it("falls back to a humanized signal name when a requirement has no label", () => {
    const r = gateReasons({ require: [{ signal: "fleetStreams", target: 1 }] }, { fleetStreams: 0 });
    expect(r[0].label).toBe("fleet streams");
  });

  it("an empty/absent gate has no reasons", () => {
    expect(gateReasons(undefined, {})).toEqual([]);
    expect(gateReasons({ require: [] }, {})).toEqual([]);
  });
});
