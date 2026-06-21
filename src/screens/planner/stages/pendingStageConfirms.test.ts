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

// The context manifest requiring those four (#1019) — the dynamic required-set the approve gesture
// gates on (replaces the old hardcoded CORE).
const coreManifest = ["goal", "scope", "stack", "architecture"].map((topic) => ({ topic, required: true, confirmed: false }));

describe("pendingStageConfirms — one-click stage approval (#807-followup)", () => {
  it("context: returns every drafted project-tier context file once every required topic is present", () => {
    const sections = [...coreDrafted, sec("api", "drafted"), sec("schema", "confirmed")];
    // All four required + the drafted extra topic; the already-confirmed one is excluded.
    expect(pendingStageConfirms("context", sections, coreManifest).sort())
      .toEqual(["api", "architecture", "goal", "scope", "stack"]);
  });

  it("context: an empty manifest (no required topics) approves nothing", () => {
    // The dynamic gate can't auto-pass before the required-set is seeded (#1019).
    expect(pendingStageConfirms("context", coreDrafted, [])).toEqual([]);
  });

  it("context: waits for EVERY required topic to be present before anything can be approved", () => {
    // stack + architecture not yet written — approving now could pass the gate prematurely, so
    // confirm nothing until all required topics exist.
    const partial = [sec("goal", "drafted"), sec("scope", "drafted")];
    expect(pendingStageConfirms("context", partial, coreManifest)).toEqual([]);
  });

  it("context: a pending (empty, contentless) required file does not count as present", () => {
    const sections = [...coreDrafted.slice(0, 3), sec("architecture", "pending")];
    expect(pendingStageConfirms("context", sections, coreManifest)).toEqual([]);
  });

  it("context: nothing left to confirm once every topic is confirmed", () => {
    const allConfirmed = coreDrafted.map((s) => ({ ...s, state: "confirmed" as SectionState }));
    expect(pendingStageConfirms("context", allConfirmed, coreManifest)).toEqual([]);
  });

  it("context: excludes the phases anchor (it belongs to the structure stage)", () => {
    const sections = [...coreDrafted, sec("phases", "drafted")];
    expect(pendingStageConfirms("context", sections, coreManifest)).not.toContain("phases");
  });

  it("context: ignores repo-tier sections — only project-tier context files", () => {
    const sections = [...coreDrafted, sec("repo__web__api", "drafted")];
    expect(pendingStageConfirms("context", sections, coreManifest)).not.toContain("repo__web__api");
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

  it("a GATED active stage confirms nothing extra by key (it completes via its gate)", () => {
    expect(stageConfirmKeys("repos", [], /*activeHasGate*/ true, false)).toEqual([]);
  });

  it("a GATED structure/context stage confirms its gate's drafted anchors", () => {
    // structure (gated) → the phases anchor
    expect(stageConfirmKeys("structure", [sec("phases", "drafted")], /*activeHasGate*/ true, false)).toEqual(["phases"]);
    // context (gated) → the required context files (from the manifest)
    expect(stageConfirmKeys("context", coreDrafted, /*activeHasGate*/ true, false, coreManifest).sort())
      .toEqual(["architecture", "goal", "scope", "stack"]);
  });

  it("a GATELESS context/structure (e.g. an IMPORTED blueprint) confirms ITS OWN key, not the anchors", () => {
    // Imported blueprints lose their gateRules, so even a `context`/`structure` stage is gateless and
    // completes via confirmed:<its-key> — NOT the discovery/phases anchors (which feed a gate it lacks).
    expect(stageConfirmKeys("context", coreDrafted, /*activeHasGate*/ false, false)).toEqual(["context"]);
    expect(stageConfirmKeys("structure", [sec("phases", "drafted")], /*activeHasGate*/ false, false)).toEqual(["structure"]);
  });

  it("no active stage ⇒ nothing to confirm", () => {
    expect(stageConfirmKeys(undefined, [], false, false)).toEqual([]);
  });
});
