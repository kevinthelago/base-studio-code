import { describe, it, expect } from "vitest";
import {
  phasesFrom, activeIndex, clampIndex, gatePill, footerAction, resolveFooter, currentGateReady, connectorKind,
  sectionForPhase, shouldAutoCompleteGate, type Phase, type PhaseStatus,
} from "./focusedPlan";
import { confirmedSignal, skippedSignal, type BlueprintSection } from "./blueprints";
import type { PlanSignals } from "./stageGate";

const sec = (key: string, over: Partial<BlueprintSection> = {}): BlueprintSection => ({
  uid: key, key, name: key.toUpperCase(), glyph: "•", gate: `${key} gate`,
  deps: [], blurb: `${key} blurb`, prompt: "", enabled: true, expanded: false,
  ...over,
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

  it("STOPS on a reached optional stage (active); only a USER-skip renders it 'skipped' (#921)", () => {
    const secs: BlueprintSection[] = [
      sec("a", { gateRule: { require: [{ signal: "a", target: true }] } }),
      sec("opt", { optional: true, gateRule: { require: [{ signal: "opt", target: true }] } }),
      sec("b", { deps: ["a"], gateRule: { require: [{ signal: "b", target: true }] } }),
    ];
    // The flow now STOPS on the reached optional stage — it's "active", not auto-skipped (#921),
    // so the planner addresses it and the user decides. `b` isn't reached until `opt` is decided.
    const p = phasesFrom(secs, { a: true } as unknown as PlanSignals);
    expect(p.find((x) => x.key === "a")!.status).toBe("complete");
    expect(p.find((x) => x.key === "opt")!.status).toBe("active");
    expect(p.find((x) => x.key === "b")!.status).toBe("upcoming");
    // A deliberately user-skipped optional stage renders 'skipped' and the frontier advances past it.
    const p2 = phasesFrom(secs, { a: true, [skippedSignal("opt")]: true } as unknown as PlanSignals);
    expect(p2.find((x) => x.key === "opt")!.status).toBe("skipped");
    expect(p2.find((x) => x.key === "b")!.status).toBe("active");
    // An optional stage the cursor hasn't reached isn't 'skipped' — only a deliberate skip is.
    const p3 = phasesFrom([sec("a", { gateRule: { require: [{ signal: "a", target: true }] } }), sec("opt", { optional: true })], {} as PlanSignals);
    expect(p3.find((x) => x.key === "opt")!.status).not.toBe("skipped");
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
  it("pass when the gate is satisfied (complete), else wait", () => {
    expect(gatePill(p.find((x) => x.key === "a")!)).toBe("pass");
    expect(gatePill(p.find((x) => x.key === "b")!)).toBe("wait");
  });
});

describe("footerAction (#652)", () => {
  it("navigates by selection vs active, publishes when complete", () => {
    expect(footerAction(2, 1, false, false).kind).toBe("back-to-current");
    expect(footerAction(0, 1, false, false).kind).toBe("jump-to-current");
    expect(footerAction(1, 1, true, false)).toEqual({ kind: "publish", enabled: true });
    expect(footerAction(1, 1, false, true)).toEqual({ kind: "approve-continue", enabled: true, canSkip: false });
    expect(footerAction(1, 1, false, false)).toEqual({ kind: "approve-continue", enabled: false, canSkip: false });
  });

  it("offers a skip control on the active OPTIONAL stage (#921)", () => {
    // The active phase is an enabled optional stage the user hasn't decided — `canSkip` lights up
    // alongside "approve & continue" so the USER, not the app, decides whether to skip it.
    expect(footerAction(1, 1, false, false, true)).toEqual({ kind: "approve-continue", enabled: false, canSkip: true });
    expect(footerAction(1, 1, false, true, true)).toEqual({ kind: "approve-continue", enabled: true, canSkip: true });
    // Browsing away from the active phase never offers skip.
    expect(footerAction(2, 1, false, false, true).kind).toBe("back-to-current");
  });
});

describe("resolveFooter — gate override (#1285)", () => {
  const blocked = footerAction(1, 1, false, false); // approve-continue, gate blocking
  it("passes an already-enabled or non-approve action through untouched", () => {
    const ready = footerAction(1, 1, false, true);
    expect(resolveFooter(ready, 0, true)).toBe(ready);
    const publish = footerAction(1, 1, true, false);
    expect(resolveFooter(publish, 0, true)).toBe(publish);
  });
  it("pending-confirm enables WITHOUT marking override (normal one-click approval)", () => {
    const r = resolveFooter(blocked, 2, true);
    expect(r.enabled).toBe(true);
    expect(r.override).toBeUndefined();
  });
  it("override enables + flags a blocking gate ONLY when allowed and nothing to confirm", () => {
    expect(resolveFooter(blocked, 0, false)).toEqual(blocked);          // off → still blocked
    const r = resolveFooter(blocked, 0, true);
    expect(r).toMatchObject({ kind: "approve-continue", enabled: true, override: true });
  });
});

describe("currentGateReady (#652)", () => {
  it("reflects the active section's gate", () => {
    expect(currentGateReady(SECTIONS, {})).toBe(false);          // a's gate not met
    expect(currentGateReady(SECTIONS, { a: true })).toBe(false); // now b active, b not met
    expect(currentGateReady(SECTIONS, { a: true, b: true })).toBe(true); // b met → all done, last complete
  });
});

describe("sectionForPhase (#815)", () => {
  it("resolves the section by key, surviving the phases/sections index skew", () => {
    // `c` is dropped from the visible phases (appliesWhen showC=false), so the phase at index 1
    // is `b` — but in the RAW section list index 1 is also `b` here; the real skew shows once a
    // section BEFORE the target is dropped. Build that case explicitly:
    const sections = [sec("ui", { appliesWhen: { signal: "showUi", target: true } }), sec("features"), sec("structure")];
    // showUi=false ⇒ phases = [features, structure]; phase index 0 is `features`.
    const phases = phasesFrom(sections, {});
    expect(phases.map((p) => p.key)).toEqual(["features", "structure"]);
    // Indexing the RAW sections with the phase index 0 would wrongly pick `ui`; by-key picks `features`.
    expect(sections[0].key).toBe("ui");
    expect(sectionForPhase(sections, phases[0])?.key).toBe("features");
    expect(sectionForPhase(sections, phases[1])?.key).toBe("structure");
  });

  it("returns undefined for a missing/absent phase", () => {
    expect(sectionForPhase(SECTIONS, undefined)).toBeUndefined();
    expect(sectionForPhase(SECTIONS, { key: "nope" } as Phase)).toBeUndefined();
  });
});

describe("imported blueprint — every stage gateless (#954, the 'Feature Add' repro)", () => {
  // An IMPORTED blueprint loses its gateRules on import, so EVERY stage is gateless and completes
  // only via its own confirmed:<key> signal. This mirrors the real "Feature Add" blueprint:
  // context → architecture → structure → testing → docs(optional).
  const IMPORTED: BlueprintSection[] = [
    sec("discovery"),
    sec("architecture", { deps: ["discovery"] }),
    sec("structure", { deps: ["architecture"] }),
    sec("testing", { deps: ["structure"] }),
    sec("docs", { deps: ["structure"], optional: true }),
  ];
  const active = (s: PlanSignals): string | undefined => {
    const ps = phasesFrom(IMPORTED, s);
    return ps[activeIndex(ps)]?.key;
  };

  it("enables approve on the active gateless stage (evalGate of an absent gate is met)", () => {
    expect(currentGateReady(IMPORTED, {})).toBe(true); // gateless context → button enabled
  });

  it("confirming each stage advances the frontier through the whole blueprint", () => {
    const sig: PlanSignals = {};
    expect(active(sig)).toBe("discovery");
    sig[confirmedSignal("discovery")] = true;
    expect(active(sig)).toBe("architecture");           // ← was stuck on context before #954
    sig[confirmedSignal("architecture")] = true;
    expect(active(sig)).toBe("structure");
    sig[confirmedSignal("structure")] = true;
    expect(active(sig)).toBe("testing");
    sig[confirmedSignal("testing")] = true;
    expect(active(sig)).toBe("docs");                    // optional — flow stops here until done/skipped (#921)
    sig[confirmedSignal("docs")] = true;
    expect(phasesFrom(IMPORTED, sig).every((p) => p.status === "complete")).toBe(true);
  });
});

describe("shouldAutoCompleteGate (#1068)", () => {
  it("fires only when the flag is on, autopilot is idle, and there are pending sections", () => {
    expect(shouldAutoCompleteGate(true, false, ["phases"])).toBe(true);
    // off by default
    expect(shouldAutoCompleteGate(false, false, ["phases"])).toBe(false);
    // autopilot owns confirmation while it's driving
    expect(shouldAutoCompleteGate(true, true, ["phases"])).toBe(false);
    // nothing to confirm (e.g. a generation-gated stage) → no-op
    expect(shouldAutoCompleteGate(true, false, [])).toBe(false);
  });
});
