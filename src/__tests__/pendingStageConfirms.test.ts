import { describe, it, expect } from "vitest";
import { pendingStageConfirms, stageConfirmKeys } from "../screens/projects/planStageDerive";
import type { SectionState } from "../screens/projects/ghStructure";

type S = { k: string; state: SectionState };
const sec = (k: string, state: SectionState): S => ({ k, state });

// The four core context topics, all present + drafted (the common "planner finished discovery" case).
const coreDrafted: S[] = [
  sec("goal", "drafted"), sec("scope", "drafted"),
  sec("stack", "drafted"), sec("architecture", "drafted"),
];

describe("pendingStageConfirms — one-click stage approval (#807-followup)", () => {
  it("context: returns every drafted project-tier discovery file once the core four are present", () => {
    const sections = [...coreDrafted, sec("api", "drafted"), sec("schema", "confirmed")];
    // All four core + the drafted dynamic topic; the already-confirmed one is excluded.
    expect(pendingStageConfirms("context", sections).sort())
      .toEqual(["api", "architecture", "goal", "scope", "stack"]);
  });

  it("context: waits for ALL four core topics to be present before anything can be approved", () => {
    // stack + architecture not yet written — approving now could pass the gate prematurely
    // (coreConfirmed treats an absent core topic as satisfied), so confirm nothing.
    const partial = [sec("goal", "drafted"), sec("scope", "drafted")];
    expect(pendingStageConfirms("context", partial)).toEqual([]);
  });

  it("context: a pending (empty, contentless) core file does not count as present", () => {
    const sections = [...coreDrafted.slice(0, 3), sec("architecture", "pending")];
    expect(pendingStageConfirms("context", sections)).toEqual([]);
  });

  it("context: nothing left to confirm once every topic is confirmed", () => {
    const allConfirmed = coreDrafted.map((s) => ({ ...s, state: "confirmed" as SectionState }));
    expect(pendingStageConfirms("context", allConfirmed)).toEqual([]);
  });

  it("context: excludes the phases anchor (it belongs to the structure stage)", () => {
    const sections = [...coreDrafted, sec("phases", "drafted")];
    expect(pendingStageConfirms("context", sections)).not.toContain("phases");
  });

  it("context: ignores repo-tier sections — only project-tier discovery files", () => {
    const sections = [...coreDrafted, sec("repo__web__api", "drafted")];
    expect(pendingStageConfirms("context", sections)).not.toContain("repo__web__api");
  });

  it("structure: confirms the phases roadmap anchor when it's drafted", () => {
    expect(pendingStageConfirms("structure", [sec("phases", "drafted")])).toEqual(["phases"]);
    expect(pendingStageConfirms("structure", [sec("phases", "confirmed")])).toEqual([]);
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

  it("a GATED active stage confirms nothing by key (it completes via its gate)", () => {
    expect(stageConfirmKeys("repos", [], /*activeHasGate*/ true, false)).toEqual([]);
  });

  it("still returns the structure/context anchors from pendingStageConfirms first", () => {
    // structure anchor takes precedence over the gateless fallback
    expect(stageConfirmKeys("structure", [sec("phases", "drafted")], false, false)).toEqual(["phases"]);
    // context core-four drafted → those, not the stage key
    expect(stageConfirmKeys("context", coreDrafted, false, false).sort())
      .toEqual(["architecture", "goal", "scope", "stack"]);
  });

  it("no active stage ⇒ nothing to confirm", () => {
    expect(stageConfirmKeys(undefined, [], false, false)).toEqual([]);
  });
});
