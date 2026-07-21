import { describe, it, expect } from "vitest";
import {
  stagesFrom, activeIndex, clampIndex, gatePill, footerAction, resolveFooter, currentGateReady, connectorKind,
  sectionForStage, shouldAutoCompleteGate, type Stage, type StageStatus,
} from "./focusedPlan";
import { confirmedSignal, skippedSignal, type BlueprintStage } from "./blueprints";
import type { PlanSignals } from "./stageGate";

const sec = (key: string, over: Partial<BlueprintStage> = {}): BlueprintStage => ({
  uid: key, key, name: key.toUpperCase(), glyph: "•", icon: "category", hue: 250, gate: `${key} gate`,
  deps: [], blurb: `${key} blurb`, prompt: "", enabled: true, expanded: false,
  ...over,
});

// A → B (deps A) → C (only applies when showC)
const SECTIONS: BlueprintStage[] = [
  sec("a", { gateRule: { require: [{ signal: "a", target: true }] } }),
  sec("b", { deps: ["a"], gateRule: { require: [{ signal: "b", target: true }] } }),
  sec("c", { appliesWhen: { signal: "showC", target: true } }),
];

describe("stagesFrom (#652)", () => {
  it("marks the first reachable section active and unmet-dep sections locked; hides N/A", () => {
    const p = stagesFrom(SECTIONS, {} as PlanSignals);
    expect(p.map((x) => x.key)).toEqual(["a", "b"]); // c is N/A (showC unset)
    expect(p.find((x) => x.key === "a")!.status).toBe("active");
    expect(p.find((x) => x.key === "b")!.status).toBe("locked");
    expect(p[0].total).toBe(2);
  });

  it("advances active as gates pass", () => {
    const p = stagesFrom(SECTIONS, { a: true });
    expect(p.find((x) => x.key === "a")!.status).toBe("complete");
    expect(p.find((x) => x.key === "b")!.status).toBe("active");
  });

  it("shows an N/A section once its applicability turns on; a gateless section needs confirmation", () => {
    const p = stagesFrom(SECTIONS, { a: true, b: true, showC: true });
    expect(p.map((x) => x.key)).toEqual(["a", "b", "c"]);
    // c is gateless → NOT vacuously complete (#664); it's the active stage until confirmed.
    expect(p.find((x) => x.key === "c")!.status).toBe("active");
    // confirm c → complete.
    const p2 = stagesFrom(SECTIONS, { a: true, b: true, showC: true, [confirmedSignal("c")]: true });
    expect(p2.find((x) => x.key === "c")!.status).toBe("complete");
  });
});

describe("ahead (banked) + connectorKind (#668)", () => {
  // a (done) → b (deps a, NOT done) → c (gateless, confirmed = done out of sequence)
  it("marks a complete section past the current one as 'ahead'", () => {
    const p = stagesFrom(SECTIONS, { a: true, showC: true, [confirmedSignal("c")]: true });
    // a complete (behind), b active (current), c complete-but-past-current → ahead
    expect(p.find((x) => x.key === "a")!.status).toBe("complete");
    expect(p.find((x) => x.key === "b")!.status).toBe("active");
    expect(p.find((x) => x.key === "c")!.status).toBe("ahead");
  });

  it("connectorKind: green up to + INTO the current node, not out of it (#668)", () => {
    const ph = (status: StageStatus) => ({ status } as unknown as Stage);
    // complete · complete · active · upcoming · ahead
    const list = [ph("complete"), ph("complete"), ph("active"), ph("upcoming"), ph("ahead")];
    expect(connectorKind(list, 0)).toBe("solid"); // complete → complete
    expect(connectorKind(list, 1)).toBe("solid"); // complete → ACTIVE  (the IN connector is green)
    expect(connectorKind(list, 2)).toBe("dim");   // ACTIVE → upcoming   (the OUT connector is NOT green)
    expect(connectorKind(list, 3)).toBe("dashed"); // upcoming → ahead   (banked)
  });

  it("STOPS on a reached optional stage (active); only a USER-skip renders it 'skipped' (#921)", () => {
    const secs: BlueprintStage[] = [
      sec("a", { gateRule: { require: [{ signal: "a", target: true }] } }),
      sec("opt", { optional: true, gateRule: { require: [{ signal: "opt", target: true }] } }),
      sec("b", { deps: ["a"], gateRule: { require: [{ signal: "b", target: true }] } }),
    ];
    // The flow now STOPS on the reached optional stage — it's "active", not auto-skipped (#921),
    // so the planner addresses it and the user decides. `b` isn't reached until `opt` is decided.
    const p = stagesFrom(secs, { a: true } as unknown as PlanSignals);
    expect(p.find((x) => x.key === "a")!.status).toBe("complete");
    expect(p.find((x) => x.key === "opt")!.status).toBe("active");
    expect(p.find((x) => x.key === "b")!.status).toBe("upcoming");
    // A deliberately user-skipped optional stage renders 'skipped' and the frontier advances past it.
    const p2 = stagesFrom(secs, { a: true, [skippedSignal("opt")]: true } as unknown as PlanSignals);
    expect(p2.find((x) => x.key === "opt")!.status).toBe("skipped");
    expect(p2.find((x) => x.key === "b")!.status).toBe("active");
    // An optional stage the cursor hasn't reached isn't 'skipped' — only a deliberate skip is.
    const p3 = stagesFrom([sec("a", { gateRule: { require: [{ signal: "a", target: true }] } }), sec("opt", { optional: true })], {} as PlanSignals);
    expect(p3.find((x) => x.key === "opt")!.status).not.toBe("skipped");
  });

  it("the connector leaving a SKIPPED section before the active stays green (#668)", () => {
    const ph = (status: StageStatus) => ({ status } as unknown as Stage);
    // context done · UI skipped/optional (upcoming) · structure active
    const list = [ph("complete"), ph("upcoming"), ph("active")];
    expect(connectorKind(list, 0)).toBe("solid"); // context → skipped UI
    expect(connectorKind(list, 1)).toBe("solid"); // skipped UI → ACTIVE structure (green leads in)
  });
});

describe("activeIndex / clampIndex (#652)", () => {
  it("returns the active stage index, else the last", () => {
    expect(activeIndex(stagesFrom(SECTIONS, {}))).toBe(0);
    expect(activeIndex(stagesFrom(SECTIONS, { a: true }))).toBe(1);
    expect(activeIndex(stagesFrom(SECTIONS, { a: true, b: true, showC: true }))).toBe(2); // none active → last
  });
  it("clamps into range", () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(0, 0)).toBe(0);
  });
});

describe("gatePill (#652)", () => {
  const p = stagesFrom(SECTIONS, { a: true }); // a complete, b active
  it("pass when the gate is satisfied (complete), else wait", () => {
    expect(gatePill(p.find((x) => x.key === "a")!)).toBe("pass");
    expect(gatePill(p.find((x) => x.key === "b")!)).toBe("wait");
  });
});

describe("footerAction (#652/#2533)", () => {
  it("navigates by selection vs active, publishes when complete", () => {
    expect(footerAction(2, 1, false, false).kind).toBe("back-to-current");
    expect(footerAction(0, 1, false, false).kind).toBe("jump-to-current");
    expect(footerAction(1, 1, true, false)).toEqual({ kind: "publish", enabled: true });
  });

  it("marks every active stage skip-ELIGIBLE (#2533/#2854) — resolveFooter decides the actual render", () => {
    // On the active stage, `canSkip` is a marker (skip-eligible KIND); whether Skip actually RENDERS
    // is decided later by resolveFooter (`skipEnabled`) from the live signals.
    expect(footerAction(1, 1, false, true)).toEqual({ kind: "approve-continue", enabled: true, canSkip: true });
    expect(footerAction(1, 1, false, false)).toEqual({ kind: "approve-continue", enabled: false, canSkip: true });
    // Browsing away from the active stage is never skip-eligible.
    expect(footerAction(2, 1, false, false).kind).toBe("back-to-current");
    expect(footerAction(0, 1, false, false).canSkip).toBeUndefined();
  });

  it("routes the design on the active UI stage when it's missing/stale, still offering skip (#2121/#2533)", () => {
    // routeDesign=true on the active stage → an always-enabled "route-design" primary instead of
    // "approve & continue". Skip is now ALSO shown (#2533) — routing and skipping are both valid.
    expect(footerAction(1, 1, false, false, true)).toEqual({ kind: "route-design", enabled: true, canSkip: true });
    expect(footerAction(1, 1, false, true, true)).toEqual({ kind: "route-design", enabled: true, canSkip: true });
    // route-design never overrides navigation or publish.
    expect(footerAction(2, 1, false, false, true).kind).toBe("back-to-current");
    expect(footerAction(1, 1, true, false, true)).toEqual({ kind: "publish", enabled: true });
    // Once the design is current (routeDesign=false) it reverts to the normal advance action.
    expect(footerAction(1, 1, false, true, false).kind).toBe("approve-continue");
  });
});

describe("resolveFooter — skip gating + one-click confirm (#1285/#2854)", () => {
  const blocked = footerAction(1, 1, false, false); // approve-continue, gate blocking, canSkip
  it("passes a non-skippable action (publish/nav) through untouched", () => {
    const publish = footerAction(1, 1, true, false);
    expect(resolveFooter(publish, 0, true, false)).toBe(publish);
    const nav = footerAction(2, 1, false, false);
    expect(resolveFooter(nav, 0, false, false)).toBe(nav);
  });
  it("renders Skip only when the stage is skippable now, or with gate override (#2854)", () => {
    expect(resolveFooter(blocked, 0, false, true).skipEnabled).toBe(true);   // skippable → render
    // A required stage (not skippable, override off) renders NO Skip — the #2854 ghost fix.
    expect(resolveFooter(blocked, 0, false, false).skipEnabled).toBe(false);
    expect(resolveFooter(blocked, 0, true, false).skipEnabled).toBe(true);   // required + override on
    // Skip gating never touches the primary, and there is no `override` flag anymore.
    expect(resolveFooter(blocked, 0, true, false).enabled).toBe(false);
    expect("override" in resolveFooter(blocked, 0, true, false)).toBe(false);
  });
  it("pending-confirm lights the primary; nothing else force-enables a blocking gate", () => {
    expect(resolveFooter(blocked, 2, false, false).enabled).toBe(true);  // drafted sections → confirm
    expect(resolveFooter(blocked, 0, false, false).enabled).toBe(false); // nothing pending → blocked
    expect(resolveFooter(blocked, 0, true, true).enabled).toBe(false);   // override enables SKIP, not primary
  });
});

describe("stagesFrom → Stage.skippable (#2854)", () => {
  it("is true for an intrinsically optional stage, false for a plain required one", () => {
    const secs: BlueprintStage[] = [
      sec("discovery", { gateRule: { require: [{ signal: "d", target: true }] } }),
      sec("extras", { optional: true }),
    ];
    const p = stagesFrom(secs, {} as PlanSignals);
    expect(p.find((x) => x.key === "discovery")!.skippable).toBe(false); // no rule → required
    expect(p.find((x) => x.key === "extras")!.skippable).toBe(true);     // optional → always skippable
  });

  it("follows a declarative skipWhen against live signals — empty ⇒ skippable, populated ⇒ required", () => {
    const secs: BlueprintStage[] = [
      sec("features", {
        gateRule: { require: [{ signal: "featuresDefined", target: 1 }] },
        skipWhen: { signal: "featuresDefined", target: 0, op: "==" },
      }),
    ];
    // Empty (0 features) → skippable; the footer offers Skip.
    expect(stagesFrom(secs, { featuresDefined: 0 }).find((x) => x.key === "features")!.skippable).toBe(true);
    // Populated → required; Skip disappears and the gate must pass.
    expect(stagesFrom(secs, { featuresDefined: 2 }).find((x) => x.key === "features")!.skippable).toBe(false);
  });
});

describe("currentGateReady (#652)", () => {
  it("reflects the active section's gate", () => {
    expect(currentGateReady(SECTIONS, {})).toBe(false);          // a's gate not met
    expect(currentGateReady(SECTIONS, { a: true })).toBe(false); // now b active, b not met
    expect(currentGateReady(SECTIONS, { a: true, b: true })).toBe(true); // b met → all done, last complete
  });
});

describe("sectionForStage (#815)", () => {
  it("resolves the section by key, surviving the stages/sections index skew", () => {
    // `c` is dropped from the visible stages (appliesWhen showC=false), so the stage at index 1
    // is `b` — but in the RAW section list index 1 is also `b` here; the real skew shows once a
    // section BEFORE the target is dropped. Build that case explicitly:
    const sections = [sec("ui", { appliesWhen: { signal: "showUi", target: true } }), sec("features"), sec("streams")];
    // showUi=false ⇒ stages = [features, structure]; stage index 0 is `features`.
    const stages = stagesFrom(sections, {});
    expect(stages.map((p) => p.key)).toEqual(["features", "streams"]);
    // Indexing the RAW sections with the stage index 0 would wrongly pick `ui`; by-key picks `features`.
    expect(sections[0].key).toBe("ui");
    expect(sectionForStage(sections, stages[0])?.key).toBe("features");
    expect(sectionForStage(sections, stages[1])?.key).toBe("streams");
  });

  it("returns undefined for a missing/absent stage", () => {
    expect(sectionForStage(SECTIONS, undefined)).toBeUndefined();
    expect(sectionForStage(SECTIONS, { key: "nope" } as Stage)).toBeUndefined();
  });
});

describe("imported blueprint — every stage gateless (#954, the 'Feature Add' repro)", () => {
  // An IMPORTED blueprint loses its gateRules on import, so EVERY stage is gateless and completes
  // only via its own confirmed:<key> signal. This mirrors the real "Feature Add" blueprint:
  // context → architecture → structure → testing → docs(optional).
  const IMPORTED: BlueprintStage[] = [
    sec("discovery"),
    sec("architecture", { deps: ["discovery"] }),
    sec("streams", { deps: ["architecture"] }),
    sec("testing", { deps: ["streams"] }),
    sec("docs", { deps: ["streams"], optional: true }),
  ];
  const active = (s: PlanSignals): string | undefined => {
    const ps = stagesFrom(IMPORTED, s);
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
    expect(active(sig)).toBe("streams");
    sig[confirmedSignal("streams")] = true;
    expect(active(sig)).toBe("testing");
    sig[confirmedSignal("testing")] = true;
    expect(active(sig)).toBe("docs");                    // optional — flow stops here until done/skipped (#921)
    sig[confirmedSignal("docs")] = true;
    expect(stagesFrom(IMPORTED, sig).every((p) => p.status === "complete")).toBe(true);
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
