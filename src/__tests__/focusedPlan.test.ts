import { describe, it, expect } from "vitest";
import {
  phasesFrom, activeIndex, clampIndex, gatePill, footerAction, currentGateReady,
} from "../screens/projects/focusedPlan";
import { confirmedSignal, type BlueprintSection } from "../screens/projects/blueprints";
import type { PlanSignals } from "../screens/projects/stageGate";

const sec = (key: string, over: Partial<BlueprintSection> = {}): BlueprintSection => ({
  uid: key, key, name: key.toUpperCase(), glyph: "•", gate: `${key} gate`,
  deps: [], blurb: `${key} blurb`, prompt: "", enabled: true, expanded: false,
  pipelines: [], ...over,
});

// A → B (deps A) → C (only applies when showC)
const SECTIONS: BlueprintSection[] = [
  sec("a", { gateRule: { require: [{ signal: "a", target: true }] } }),
  sec("b", { deps: ["a"], gateRule: { require: [{ signal: "b", target: true }] } }),
  sec("c", { appliesWhen: { signal: "showC", target: true } }),
];

describe("phasesFrom (#652)", () => {
  it("marks the first reachable section active and unmet-dep sections locked; hides N/A", () => {
    const p = phasesFrom(SECTIONS, {} as PlanSignals);
    expect(p.map((x) => x.key)).toEqual(["a", "b"]); // c is N/A (showC unset)
    expect(p.find((x) => x.key === "a")!.status).toBe("active");
    expect(p.find((x) => x.key === "b")!.status).toBe("locked");
    expect(p[0].total).toBe(2);
  });

  it("advances active as gates pass", () => {
    const p = phasesFrom(SECTIONS, { a: true });
    expect(p.find((x) => x.key === "a")!.status).toBe("complete");
    expect(p.find((x) => x.key === "b")!.status).toBe("active");
  });

  it("shows an N/A section once its applicability turns on; a gateless section needs confirmation", () => {
    const p = phasesFrom(SECTIONS, { a: true, b: true, showC: true });
    expect(p.map((x) => x.key)).toEqual(["a", "b", "c"]);
    // c is gateless → NOT vacuously complete (#664); it's the active phase until confirmed.
    expect(p.find((x) => x.key === "c")!.status).toBe("active");
    // confirm c → complete.
    const p2 = phasesFrom(SECTIONS, { a: true, b: true, showC: true, [confirmedSignal("c")]: true });
    expect(p2.find((x) => x.key === "c")!.status).toBe("complete");
  });
});

describe("activeIndex / clampIndex (#652)", () => {
  it("returns the active phase index, else the last", () => {
    expect(activeIndex(phasesFrom(SECTIONS, {}))).toBe(0);
    expect(activeIndex(phasesFrom(SECTIONS, { a: true }))).toBe(1);
    expect(activeIndex(phasesFrom(SECTIONS, { a: true, b: true, showC: true }))).toBe(2); // none active → last
  });
  it("clamps into range", () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(0, 0)).toBe(0);
  });
});

describe("gatePill (#652)", () => {
  const p = phasesFrom(SECTIONS, { a: true }); // a complete, b active
  it("pass when complete, blocked when a gate-pipeline blocks, else wait", () => {
    expect(gatePill(p.find((x) => x.key === "a")!, false)).toBe("pass");
    expect(gatePill(p.find((x) => x.key === "b")!, false)).toBe("wait");
    expect(gatePill(p.find((x) => x.key === "b")!, true)).toBe("blocked");
  });
});

describe("footerAction (#652)", () => {
  it("navigates by selection vs active, publishes when complete", () => {
    expect(footerAction(2, 1, false, false).kind).toBe("back-to-current");
    expect(footerAction(0, 1, false, false).kind).toBe("jump-to-current");
    expect(footerAction(1, 1, true, false)).toEqual({ kind: "publish", enabled: true });
    expect(footerAction(1, 1, false, true)).toEqual({ kind: "approve-continue", enabled: true });
    expect(footerAction(1, 1, false, false)).toEqual({ kind: "approve-continue", enabled: false });
  });
});

describe("currentGateReady (#652)", () => {
  it("reflects the active section's gate", () => {
    expect(currentGateReady(SECTIONS, {})).toBe(false);          // a's gate not met
    expect(currentGateReady(SECTIONS, { a: true })).toBe(false); // now b active, b not met
    expect(currentGateReady(SECTIONS, { a: true, b: true })).toBe(true); // b met → all done, last complete
  });
});
