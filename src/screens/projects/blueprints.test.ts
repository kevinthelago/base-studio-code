import { describe, it, expect } from "vitest";
import { SECTION_DEFS } from "./blueprints";

// #850 — the planner should propose the most complete, production-grade solution by
// default, not a truncated "starter" cut. The Features stage is where scope is set, so
// its prompt is the load-bearing place to assert the posture.
describe("Features stage posture (#850)", () => {
  const features = SECTION_DEFS.features;
  const propose = features.substeps?.find((s) => s.key === "propose");

  it("asks for the complete, production-grade capability set", () => {
    expect(propose).toBeDefined();
    const p = propose!.prompt.toLowerCase();
    expect(p).toContain("complete set");
    expect(p).toContain("production-grade");
  });

  it("does not default to a truncated 'starter / enough to get going' set", () => {
    const all = `${features.prompt} ${propose?.prompt ?? ""}`.toLowerCase();
    expect(all).not.toContain("starter set");
    expect(all).not.toContain("enough to get going");
  });

  it("keeps completeness separate from phasing (the user still sequences)", () => {
    // Completeness is about capabilities; the prompt must not pre-trim to a phase-1 slice.
    expect(propose!.prompt.toLowerCase()).toContain("phas");
  });
});
