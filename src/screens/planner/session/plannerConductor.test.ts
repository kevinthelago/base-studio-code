import { describe, it, expect } from "vitest";
import { nextInjection, isStepDelivered, flattenPrompt, stagePrompts, type ConductorState, type DeliverySignals } from "./plannerConductor";
import { mkSection } from "../stages/blueprints";

const sig = (over: Partial<DeliverySignals> = {}): DeliverySignals => ({
  outputGrew: false, sectionKeys: new Set(), startedFeatures: new Set(), featuresExist: false, ...over,
});

const emptyState = (): ConductorState => ({ doneSubsteps: new Set(), loops: {} });
const state = (over: Partial<ConductorState> = {}): ConductorState => ({ doneSubsteps: new Set(), loops: {}, ...over });

describe("stagePrompts — the on-demand '?' helper list (#…)", () => {
  it("lists the stage overview prompt first, then each substep prompt", () => {
    const context = mkSection("context");
    const list = stagePrompts(context);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].label).toContain("overview");
    expect(list[0].text).toBe(context.prompt);
    // every listed prompt has non-empty text, and the core discovery substeps are present
    expect(list.every((p) => p.text.trim().length > 0)).toBe(true);
    const labels = list.map((p) => p.label.toLowerCase()).join(" ");
    expect(labels).toMatch(/goal/);
  });

  it("returns [] for no section", () => {
    expect(stagePrompts(undefined)).toEqual([]);
  });
});

describe("nextInjection — stage + static substeps", () => {
  const context = mkSection("context"); // _stage + goal/scope/stack/architecture + dimensions(loop)

  it("returns null when there is no active section", () => {
    expect(nextInjection(undefined, new Set(), emptyState())).toBeNull();
  });

  it("injects the stage prompt first, then the first substep", () => {
    expect(nextInjection(context, new Set(), emptyState())?.id).toBe("context:_stage");
    expect(nextInjection(context, new Set(["context:_stage"]), emptyState())?.id).toBe("context:goal");
  });

  it("waits on an injected-but-not-done substep, and advances once it's done", () => {
    const injected = new Set(["context:_stage", "context:goal"]);
    expect(nextInjection(context, injected, emptyState())).toBeNull();
    expect(nextInjection(context, injected, state({ doneSubsteps: new Set(["goal"]) }))?.id).toBe("context:scope");
  });

  it("a substep-less stage injects only its stage prompt, once", () => {
    const permissions = mkSection("permissions");
    expect(nextInjection(permissions, new Set(), emptyState())?.id).toBe("permissions:_stage");
    expect(nextInjection(permissions, new Set(["permissions:_stage"]), emptyState())).toBeNull();
  });
});

describe("nextInjection — features loop (Phase 3)", () => {
  const features = mkSection("features"); // _stage + propose(static) + features(loop)

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
    expect(isStepDelivered("context:stack", sig({ sectionKeys: new Set(["stack"]) }))).toBe(true);
    expect(isStepDelivered("context:stack", sig())).toBe(false); // no file, no output
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
    expect(isStepDelivered("context:_stage", sig())).toBe(false);
    expect(isStepDelivered("context:_stage", sig({ outputGrew: true }))).toBe(true);
    // the fallback delivers ANY step when the planner responded
    expect(isStepDelivered("context:stack", sig({ outputGrew: true }))).toBe(true);
  });
});
