import { describe, it, expect } from "vitest";
import { pendingStageConfirms, stageConfirmKeys } from "./planStageDerive";
import type { SectionState } from "../github/ghStructure";

type S = { k: string; state: SectionState };
const sec = (k: string, state: SectionState): S => ({ k, state });

// The four core context topics, all present + drafted (the common "planner finished discovery" case).
const coreDrafted: S[] = [
  sec("goal", "drafted"), sec("scope", "drafted"),
  sec("stack", "drafted"), sec("architecture", "drafted"),
];

describe("pendingStageConfirms — one-click stage approval (#807-followup)", () => {
  it("context: nothing to confirm — context files gate on GENERATION, not confirmation (#1028)", () => {
    const sections = [...coreDrafted, sec("api", "drafted"), sec("schema", "confirmed")];
    expect(pendingStageConfirms("discovery", sections)).toEqual([]);
  });

  it("structure: nothing to confirm — milestone phases were removed (#1912)", () => {
    // The Structure stage no longer confirms a `phases` roadmap anchor; it gates on featuresDefined.
    expect(pendingStageConfirms("structure", [sec("phases", "drafted")])).toEqual([]);
    expect(pendingStageConfirms("structure", [])).toEqual([]);
  });

  it("count-gated stages (permissions, features, …) have nothing to confirm by section", () => {
    expect(pendingStageConfirms("permissions", coreDrafted)).toEqual([]);
    expect(pendingStageConfirms(undefined, coreDrafted)).toEqual([]);
  });
});

describe("stageConfirmKeys — gateless active-stage approval (#954)", () => {
  it("confirms a GATELESS active stage by its own key so the frontier advances", () => {
    // A gateless informational stage (no gateRule) with nothing for pendingStageConfirms to find:
    // approve must confirm the stage itself.
    expect(stageConfirmKeys("cleanup", [], /*activeHasGate*/ false, /*confirmed*/ false)).toEqual(["cleanup"]);
  });

  it("does NOT re-confirm a gateless stage that's already confirmed", () => {
    expect(stageConfirmKeys("cleanup", [], false, true)).toEqual([]);
  });

  it("a GATED active stage confirms nothing extra by key (it completes via its gate)", () => {
    expect(stageConfirmKeys("repos", [], /*activeHasGate*/ true, false)).toEqual([]);
  });

  it("a GATED structure/context confirms nothing extra by key — they complete via their gate (#1912)", () => {
    // structure (gated) gates on featuresDefined now — no phases anchor to confirm
    expect(stageConfirmKeys("structure", [sec("phases", "drafted")], /*activeHasGate*/ true, false)).toEqual([]);
    // context (gated) → no confirm step; the files are done once written (#1028)
    expect(stageConfirmKeys("discovery", coreDrafted, /*activeHasGate*/ true, false)).toEqual([]);
  });

  it("a GATELESS context/structure (e.g. an IMPORTED blueprint) confirms ITS OWN key, not the anchors", () => {
    // Imported blueprints lose their gateRules, so even a `context`/`structure` stage is gateless and
    // completes via confirmed:<its-key>.
    expect(stageConfirmKeys("discovery", coreDrafted, /*activeHasGate*/ false, false)).toEqual(["discovery"]);
    expect(stageConfirmKeys("structure", [sec("phases", "drafted")], /*activeHasGate*/ false, false)).toEqual(["structure"]);
  });

  it("no active stage ⇒ nothing to confirm", () => {
    expect(stageConfirmKeys(undefined, [], false, false)).toEqual([]);
  });
});
