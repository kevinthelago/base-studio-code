import { describe, it, expect } from "vitest";
import {
  phasesFrom, activeIndex, clampIndex, gatePill, footerAction, currentGateReady, connectorKind,
  type Phase, type PhaseStatus,
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

describe("ahead (banked) + connectorKind (#668)", () => {
  // a (done) → b (deps a, NOT done) → c (gateless, confirmed = done out of sequence)
  it("marks a complete section past the current one as 'ahead'", () => {
    const p = phasesFrom(SECTIONS, { a: true, showC: true, [confirmedSignal("c")]: true });
    // a complete (behind), b active (current), c complete-but-past-current → ahead
    expect(p.find((x) => x.key === "a")!.status).toBe("complete");
    expect(p.find((x) => x.key === "b")!.status).toBe("active");
    expect(p.find((x) => x.key === "c")!.status).toBe("ahead");
  });

  it("connectorKind: green up to + INTO the current node, not out of it (#668)", () => {
    const ph = (status: PhaseStatus) => ({ status } as unknown as Phase);
    // complete · complete · active · upcoming · ahead
    const list = [ph("complete"), ph("complete"), ph("active"), ph("upcoming"), ph("ahead")];
    expect(connectorKind(list, 0)).toBe("solid"); // complete → complete
    expect(connectorKind(list, 1)).toBe("solid"); // complete → ACTIVE  (the IN connector is green)
    expect(connectorKind(list, 2)).toBe("dim");   // ACTIVE → upcoming   (the OUT connector is NOT green)
    expect(connectorKind(list, 3)).toBe("dashed"); // upcoming → ahead   (banked)
  });

  it("marks an optional section the cursor has passed as 'skipped' (#678)", () => {
    const secs: BlueprintSection[] = [
      sec("a", { gateRule: { require: [{ signal: "a", target: true }] } }),
      sec("opt", { optional: true, gateRule: { require: [{ signal: "opt", target: true }] } }),
      sec("b", { deps: ["a"], gateRule: { require: [{ signal: "b", target: true }] } }),
    ];
    const p = phasesFrom(secs, { a: true } as unknown as PlanSignals);
    expect(p.find((x) => x.key === "a")!.status).toBe("complete");
    expect(p.find((x) => x.key === "opt")!.status).toBe("skipped"); // optional, passed, unfinished
    expect(p.find((x) => x.key === "b")!.status).toBe("active");
    // an optional section the cursor HASN'T reached yet stays "upcoming", not "skipped"
    const p2 = phasesFrom([sec("a"), sec("opt", { optional: true })], {} as PlanSignals);
    expect(p2.find((x) => x.key === "opt")!.status).toBe("upcoming");
  });

  it("the connector leaving a SKIPPED section before the active stays green (#668)", () => {
    const ph = (status: PhaseStatus) => ({ status } as unknown as Phase);
    // context done · UI skipped/optional (upcoming) · structure active
    const list = [ph("complete"), ph("upcoming"), ph("active")];
    expect(connectorKind(list, 0)).toBe("solid"); // context → skipped UI
    expect(connectorKind(list, 1)).toBe("solid"); // skipped UI → ACTIVE structure (green leads in)
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
