import { describe, it, expect } from "vitest";
import { GLANCE_NODE_MOTION_CSS, GLANCE_NODE_ANIM_CLASSES, ensureGlanceNodeMotion } from "./glanceNodeMotion";
import { GLANCE_NODE_ANIMATIONS } from "@/shared/ui/kit/glanceNodeAnimations";

describe("glance-node motion is authored DATA (#4032)", () => {
  it("compiles the authored data to real CSS", () => {
    // Before this the node's motion was a raw keyframe in glance.css + an inline boxShadow, so the
    // designer could not reach it. The store held 254 component records and ZERO motion.
    expect(GLANCE_NODE_MOTION_CSS).toContain("@keyframes");
    expect(GLANCE_NODE_MOTION_CSS).toContain("bsc-glance-node-building");
    expect(GLANCE_NODE_MOTION_CSS).toContain("bsc-glance-node-attention");
  });

  it("emits INFINITE for the state animations", () => {
    // The load-bearing bit: these play for as long as the node is in the state, unlike the viz kits'
    // one-shot transitions. `trigger: "always"` is how the engine already models that — no schema
    // change was needed, nobody had just authored one.
    expect(GLANCE_NODE_ANIMATIONS.every((a) => a.trigger === "always")).toBe(true);
    const infinites = GLANCE_NODE_MOTION_CSS.match(/infinite/g) ?? [];
    expect(infinites.length).toBe(GLANCE_NODE_ANIMATIONS.length);
  });

  it("binds each animation to its STATE, so the selector names the state", () => {
    expect(GLANCE_NODE_MOTION_CSS).toContain('[data-node-state="building"]');
    expect(GLANCE_NODE_MOTION_CSS).toContain('[data-node-state="attention"]');
  });

  it("has NO complete animation — its stillness is the statement", () => {
    // building BREATHES, attention RINGS, complete is STILL. The absence is deliberate, so a designer
    // adding one is making a change rather than filling a gap.
    expect(GLANCE_NODE_ANIMATIONS.map((a) => a.name)).toEqual(["building", "attention"]);
    expect(GLANCE_NODE_MOTION_CSS).not.toContain("complete");
  });

  it("keeps the breath shallower and slower than the status dot", () => {
    // A whole node dipping to the dot's .45 floor reads as broken rather than busy, and a row of them
    // in unison is unpleasant. Pinned because it is a judgement that is easy to "tidy" away.
    const breath = GLANCE_NODE_ANIMATIONS.find((a) => a.name === "building")!;
    expect(breath.keyframes["50%"].opacity).toBe("0.78");
    expect(breath.duration).toBe("1800ms");
  });

  it("exposes one applying class per animation", () => {
    expect(GLANCE_NODE_ANIM_CLASSES.split(" ")).toHaveLength(GLANCE_NODE_ANIMATIONS.length);
  });

  it("injects idempotently into a managed style element", () => {
    const doc = document.implementation.createHTMLDocument("t");
    ensureGlanceNodeMotion(doc);
    ensureGlanceNodeMotion(doc);
    const els = doc.querySelectorAll("#bsc-glance-node-animations");
    expect(els).toHaveLength(1);
    expect(els[0].textContent).toBe(GLANCE_NODE_MOTION_CSS);
  });
});
