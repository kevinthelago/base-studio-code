import { describe, it, expect } from "vitest";
import { BASE_KIT_ID, BASE_ANIMATIONS } from "./baseAnimations";

describe("base motion library (#3451)", () => {
  it("owns exactly the three base motions, uniquely named", () => {
    // These moved OUT of the react-ui manifest primitives so one demo kit no longer owns motion the
    // whole platform leans on. If a name changes here, every consuming kit's reference dangles.
    expect(BASE_ANIMATIONS.map((a) => a.name)).toEqual(["lift", "fade-in", "pulse"]);
    expect(new Set(BASE_ANIMATIONS.map((a) => a.name)).size).toBe(BASE_ANIMATIONS.length);
  });

  it("preserves each motion's authored trigger + token-based timing (moved verbatim)", () => {
    const want = { lift: "hover", "fade-in": "mount", pulse: "always" } as const;
    for (const a of BASE_ANIMATIONS) {
      expect(a.trigger, `${a.name} trigger`).toBe(want[a.name as keyof typeof want]);
      // Durations/easings reference the motion tokens (#2866), never magic numbers.
      expect(a.duration, `${a.name} duration is a motion token`).toMatch(/^var\(--dur-[a-z]+\)$/);
      expect(a.easing, `${a.name} easing is a motion token`).toMatch(/^var\(--ease-[a-z]+\)$/);
      expect(Object.keys(a.keyframes ?? {}).length, `${a.name} has keyframe stops`).toBeGreaterThan(0);
    }
  });

  it("uses a kit id that is a safe CSS identifier segment", () => {
    // `BASE_KIT_ID` is interpolated into BOTH `@keyframes bsc-<kit>-<name>` and the `.<kit>-anim-<name>`
    // class the preview stamps (`compileAnimationsCss` drops any def whose kit isn't a safe ident), so an
    // unsafe id would compile to nothing and the motion would silently never play.
    expect(BASE_KIT_ID).toMatch(/^[a-zA-Z][\w-]*$/);
  });
});
