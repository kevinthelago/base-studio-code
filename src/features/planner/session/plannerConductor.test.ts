import { describe, it, expect } from "vitest";
import { nextInjection, isStepDelivered, flattenPrompt, activeStagePrompt, type ConductorState, type DeliverySignals } from "./plannerConductor";
import { mkStage } from "../stages/blueprints";

const sig = (over: Partial<DeliverySignals> = {}): DeliverySignals => ({
  outputGrew: false, sectionKeys: new Set(), startedFeatures: new Set(), featuresExist: false, ...over,
});

const emptyState = (): ConductorState => ({ doneSubsteps: new Set(), loops: {} });
const state = (over: Partial<ConductorState> = {}): ConductorState => ({ doneSubsteps: new Set(), loops: {}, ...over });

describe("activeStagePrompt — the one-at-a-time '?' helper (#2859)", () => {
  it("returns the CURRENT step: the first unfinished substep's prompt, advancing one at a time", () => {
    const discovery = mkStage("discovery");
    const first = discovery.substeps![0];
    const p0 = activeStagePrompt(discovery, new Set());
    expect(p0?.text).toBe(first.prompt);
    expect(p0?.label).toBe(first.label || first.key);
    // mark the first substep done → the helper advances to the SECOND (never shows both at once)
    const second = discovery.substeps![1];
    const p1 = activeStagePrompt(discovery, new Set([first.key]));
    expect(p1?.text).toBe(second.prompt);
  });

  it("falls back to the stage overview when the stage has no substeps", () => {
    const ui = mkStage("ui"); // ui carries no substeps
    const p = activeStagePrompt(ui, new Set());
    expect(p?.label).toContain("overview");
    expect(p?.text).toBe(ui.prompt);
  });

  it("shows the loop substep until it's complete, then the overview (loopDone)", () => {
    const features = mkStage("features"); // substeps: propose (static) + features (loop)
    const staticDone = new Set(features.substeps!.filter((s) => !s.loop).map((s) => s.key));
    const loopSub = features.substeps!.find((s) => s.loop)!;
    // static steps done + loop NOT complete → the loop substep is the current step
    expect(activeStagePrompt(features, staticDone, false)?.text).toBe(loopSub.prompt);
    // loop complete → no active substep → the stage overview
    const done = activeStagePrompt(features, staticDone, true);
    expect(done?.label).toContain("overview");
    expect(done?.text).toBe(features.prompt);
  });

  it("adapts the overview to the model tier and returns null for no section", () => {
    const s = { ...mkStage("ui"), substeps: undefined, prompt: "Base.", promptVariants: { local: "Local." } };
    expect(activeStagePrompt(s, new Set())?.text).toBe("Base.");
    expect(activeStagePrompt(s, new Set(), false, "local")?.text).toBe("Local.");
    expect(activeStagePrompt(undefined, new Set())).toBeNull();
  });
});

describe("nextInjection — stage + static substeps", () => {
  const context = mkStage("discovery"); // _stage + goal/scope/stack/architecture + dimensions(loop)

  it("returns null when there is no active section", () => {
    expect(nextInjection(undefined, new Set(), emptyState())).toBeNull();
  });

  it("injects the stage prompt first, then the first substep", () => {
    expect(nextInjection(context, new Set(), emptyState())?.id).toBe("discovery:_stage");
    expect(nextInjection(context, new Set(["discovery:_stage"]), emptyState())?.id).toBe("discovery:goal");
  });

  it("waits on an injected-but-not-done substep, and advances once it's done", () => {
    const injected = new Set(["discovery:_stage", "discovery:goal"]);
    expect(nextInjection(context, injected, emptyState())).toBeNull();
    expect(nextInjection(context, injected, state({ doneSubsteps: new Set(["goal"]) }))?.id).toBe("discovery:scope");
  });

  it("injects the tier-adapted stage prompt when a variant is defined (#1854a)", () => {
    const s = { ...mkStage("mcps"), prompt: "Base orientation.", promptVariants: { local: "Local orientation." } };
    expect(nextInjection(s, new Set(), emptyState())?.prompt).toBe("Base orientation.");
    expect(nextInjection(s, new Set(), emptyState(), "local")?.prompt).toBe("Local orientation.");
    // a tier without a variant falls back to the base prompt.
    expect(nextInjection(s, new Set(), emptyState(), "standard")?.prompt).toBe("Base orientation.");
  });

  it("a substep-less stage injects only its stage prompt, once", () => {
    // #1914: `mcps` is the substep-less stage now (permissions collapsed into `streams`, which has substeps).
    const mcps = mkStage("mcps");
    expect(nextInjection(mcps, new Set(), emptyState())?.id).toBe("mcps:_stage");
    expect(nextInjection(mcps, new Set(["mcps:_stage"]), emptyState())).toBeNull();
  });
});

describe("nextInjection — features loop (Phase 3)", () => {
  const features = mkStage("features"); // _stage + propose(static) + features(loop)

  it("runs stage → propose, and holds until propose is marked done", () => {
    expect(nextInjection(features, new Set(), emptyState())?.id).toBe("features:_stage");
    expect(nextInjection(features, new Set(["features:_stage"]), emptyState())?.id).toBe("features:propose");
    // propose injected but the list doesn't exist yet → wait
    expect(nextInjection(features, new Set(["features:_stage", "features:propose"]), emptyState())).toBeNull();
  });

  it("kicks the loop off once, then steps feature-by-feature as each is defined", () => {
    const injected = new Set(["features:_stage", "features:propose"]);
    const items = [
      { id: "invite", label: "Invite teammates", done: false },
      { id: "export", label: "Export to CSV", done: false },
    ];
    const st = (its: typeof items) => state({ doneSubsteps: new Set(["propose"]), loops: { features: its } });

    // propose done → the loop kicks off (its instructions)
    expect(nextInjection(features, injected, st(items))?.id).toBe("features:features");
    injected.add("features:features");

    // first feature pointer
    expect(nextInjection(features, injected, st(items))?.id).toBe("features:features:invite");
    injected.add("features:features:invite");

    // invite injected but not yet defined → wait
    expect(nextInjection(features, injected, st(items))).toBeNull();

    // invite defined → advance to the next feature
    const afterInvite = [{ ...items[0], done: true }, items[1]];
    expect(nextInjection(features, injected, st(afterInvite))?.id).toBe("features:features:export");
    injected.add("features:features:export");

    // both defined → nothing left to inject for this stage
    const allDone = afterInvite.map((i) => ({ ...i, done: true }));
    expect(nextInjection(features, injected, st(allDone))).toBeNull();
  });
});

describe("flattenPrompt — single-line so the CLI submits it", () => {
  it("collapses newlines + bullets to one line with no embedded newlines", () => {
    const out = flattenPrompt("Define the stack.\n• languages\n• datastores\n\nWrite stack.md.");
    expect(out).not.toContain("\n");
    expect(out).toBe("Define the stack. • languages • datastores Write stack.md.");
  });
  it("trims and collapses runs of whitespace", () => {
    expect(flattenPrompt("  a   b \t c \n ")).toBe("a b c");
  });
});

describe("isStepDelivered — artifact signal with output-grew fallback", () => {
  it("a discovery substep is delivered when its file appears", () => {
    expect(isStepDelivered("discovery:stack", sig({ sectionKeys: new Set(["stack"]) }))).toBe(true);
    expect(isStepDelivered("discovery:stack", sig())).toBe(false); // no file, no output
  });
  it("the propose step is delivered once features.json has entries", () => {
    expect(isStepDelivered("features:propose", sig({ featuresExist: true }))).toBe(true);
    expect(isStepDelivered("features:propose", sig())).toBe(false);
  });
  it("a feature loop item is delivered once that feature is being defined", () => {
    expect(isStepDelivered("features:features:invite", sig({ startedFeatures: new Set(["invite"]) }))).toBe(true);
    expect(isStepDelivered("features:features:export", sig({ startedFeatures: new Set(["invite"]) }))).toBe(false);
  });
  it("falls back to output-grew for steps with no measurable artifact", () => {
    // a stage orientation prompt has no artifact — only the fallback can mark it delivered
    expect(isStepDelivered("discovery:_stage", sig())).toBe(false);
    expect(isStepDelivered("discovery:_stage", sig({ outputGrew: true }))).toBe(true);
    // the fallback delivers ANY step when the planner responded
    expect(isStepDelivered("discovery:stack", sig({ outputGrew: true }))).toBe(true);
  });
});
