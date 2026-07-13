import { describe, it, expect, beforeEach } from "vitest";
import { compileAnimationsCss, applyAnimationsToRoot, kitAnimations, type AnimationDef } from "./animations";

const fade: AnimationDef = {
  kit: "react-ui",
  name: "fade-in",
  keyframes: { from: { opacity: "0" }, to: { opacity: "1" } },
};

describe("compileAnimationsCss (#2942)", () => {
  it("emits a @keyframes block + a reduced-motion-guarded applying rule, defaulting to the motion tokens", () => {
    const css = compileAnimationsCss([fade]);
    expect(css).toContain("@keyframes bsc-react-ui-fade-in {");
    expect(css).toContain("from {");
    expect(css).toContain("opacity: 0;");
    expect(css).toContain("@media (prefers-reduced-motion: no-preference) {");
    // default duration/easing are the #2866 motion tokens; played once, class .<kit>-anim-<name>
    expect(css).toContain(".react-ui-anim-fade-in { animation: bsc-react-ui-fade-in var(--dur-base) var(--ease-standard) 1 both; }");
  });

  it("honors the trigger and explicit duration/easing", () => {
    const hov = compileAnimationsCss([{ ...fade, name: "pulse", trigger: "hover", duration: "120ms", easing: "var(--ease-emphasized)" }]);
    expect(hov).toContain(".react-ui-anim-pulse:hover { animation: bsc-react-ui-pulse 120ms var(--ease-emphasized) 1 both; }");
    const loop = compileAnimationsCss([{ ...fade, name: "spin", trigger: "always" }]);
    expect(loop).toContain(".react-ui-anim-spin { animation: bsc-react-ui-spin var(--dur-base) var(--ease-standard) infinite both; }");
  });

  it("skips unsafe input — bad kit/name, stop, property, or injection value (defense in depth)", () => {
    expect(compileAnimationsCss([{ ...fade, kit: "React-UI" }])).toBe("");                        // uppercase kit
    expect(compileAnimationsCss([{ ...fade, name: "fade;}evil" }])).toBe("");                      // unsafe name
    expect(compileAnimationsCss([{ kit: "react-ui", name: "x", keyframes: { from: { opacity: "1; } a{" } } }])).toBe(""); // injection value
    expect(compileAnimationsCss([{ kit: "react-ui", name: "x", keyframes: { "999%extra": { opacity: "1" } } }])).toBe(""); // bad stop
    expect(compileAnimationsCss([])).toBe("");
  });

  it("keys the keyframes + class by the KIT (#2942) — two kits reuse a name without colliding", () => {
    const css = compileAnimationsCss([fade, { ...fade, kit: "vue-ui" }]);
    expect(css).toContain("@keyframes bsc-react-ui-fade-in {");
    expect(css).toContain("@keyframes bsc-vue-ui-fade-in {");
    expect(css).toContain(".react-ui-anim-fade-in {");
    expect(css).toContain(".vue-ui-anim-fade-in {");
  });
});

describe("compileAnimationsCss — child targeting + set + delay (#3054/#3056)", () => {
  it("scopes the applying rule to a child via `selector` (descendant combinator)", () => {
    const css = compileAnimationsCss([{ ...fade, name: "icon-spin", selector: ".icon" }]);
    expect(css).toContain(".react-ui-anim-icon-spin .icon { animation: bsc-react-ui-icon-spin var(--dur-base) var(--ease-standard) 1 both; }");
    // a hover trigger appends `:hover` to the FULL (child-scoped) selector
    const hov = compileAnimationsCss([{ ...fade, name: "icon-hi", trigger: "hover", selector: ".icon" }]);
    expect(hov).toContain(".react-ui-anim-icon-hi .icon:hover {");
  });

  it("emits `set` static declarations in the applying rule body, before `animation:`", () => {
    const css = compileAnimationsCss([{ ...fade, name: "rot", selector: ".arrow", set: { "transform-origin": "center", "transform-box": "fill-box" } }]);
    expect(css).toContain(".react-ui-anim-rot .arrow { transform-origin: center; transform-box: fill-box; animation: bsc-react-ui-rot var(--dur-base) var(--ease-standard) 1 both; }");
  });

  it("slots `delay` into the shorthand between easing and iteration (#3056)", () => {
    const css = compileAnimationsCss([{ ...fade, name: "fade-d", delay: "120ms" }]);
    expect(css).toContain(".react-ui-anim-fade-d { animation: bsc-react-ui-fade-d var(--dur-base) var(--ease-standard) 120ms 1 both; }");
  });

  it("refuses an injection selector — never emitted, falls back to the root class (defense in depth)", () => {
    for (const bad of ["foo{}", "a;b", "</style", "a/*"]) {
      const css = compileAnimationsCss([{ ...fade, name: "safe", selector: bad }]);
      expect(css).not.toContain(bad);                              // the injection never reaches CSS
      expect(css).toContain(".react-ui-anim-safe { animation:");   // fell back to the bare root class
    }
  });

  it("drops a `set` pair with an unsafe property or value, keeping the safe ones", () => {
    const css = compileAnimationsCss([{ ...fade, name: "s2", set: { "transform-origin": "center", "Bad-Prop": "x", color: "red; }evil{" } }]);
    expect(css).toContain("transform-origin: center;");
    expect(css).not.toContain("Bad-Prop"); // uppercase property dropped
    expect(css).not.toContain("evil");     // declaration-ending value dropped
  });

  it("is byte-identical to the pre-#3054 output when the new fields are absent (zero regression)", () => {
    const expected = `@keyframes bsc-react-ui-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: no-preference) {
  .react-ui-anim-fade-in { animation: bsc-react-ui-fade-in var(--dur-base) var(--ease-standard) 1 both; }
}`;
    expect(compileAnimationsCss([fade])).toBe(expected);
  });
});

describe("compileAnimationsCss — per-element stagger ramp (#3055)", () => {
  it("emits the base rule PLUS a bounded :nth-child(2..32) animation-delay ramp for selector + stagger", () => {
    const css = compileAnimationsCss([{ ...fade, name: "wave", selector: ".cell", stagger: "14ms" }]);
    // the base rule still applies the animation on the matched child…
    expect(css).toContain(".react-ui-anim-wave .cell { animation: bsc-react-ui-wave var(--dur-base) var(--ease-standard) 1 both; }");
    // …then each later sibling gets a cumulative delay STEP; nth-child(1) is the base (no rule for it)
    expect(css).not.toContain(":nth-child(1)");
    expect(css).toContain(".react-ui-anim-wave .cell:nth-child(2) { animation-delay: calc(1 * 14ms); }");
    expect(css).toContain(".react-ui-anim-wave .cell:nth-child(3) { animation-delay: calc(2 * 14ms); }");
    // the ramp is bounded at STAGGER_MAX (32): a rule at 32, none past it, and exactly 31 steps (2..32)
    expect(css).toContain(".react-ui-anim-wave .cell:nth-child(32) { animation-delay: calc(31 * 14ms); }");
    expect(css).not.toContain(":nth-child(33)");
    expect((css.match(/:nth-child\(/g) ?? []).length).toBe(31);
    // the ramp lives INSIDE the reduced-motion guard (one @media, one closing brace)
    expect((css.match(/@media \(prefers-reduced-motion: no-preference\)/g) ?? []).length).toBe(1);
  });

  it("folds a base `delay` into the ramp: nth-child(2) is calc(<delay> + 1 * step)", () => {
    const css = compileAnimationsCss([{ ...fade, name: "waved", selector: ".cell", stagger: "14ms", delay: "120ms" }]);
    // the base delay is in the shorthand, and every step adds onto it
    expect(css).toContain(".react-ui-anim-waved .cell { animation: bsc-react-ui-waved var(--dur-base) var(--ease-standard) 120ms 1 both; }");
    expect(css).toContain(".react-ui-anim-waved .cell:nth-child(2) { animation-delay: calc(120ms + 1 * 14ms); }");
    expect(css).toContain(".react-ui-anim-waved .cell:nth-child(3) { animation-delay: calc(120ms + 2 * 14ms); }");
  });

  it("appends the ramp to the FULL scoped(+hover) selector so specificity + trigger match", () => {
    const css = compileAnimationsCss([{ ...fade, name: "waveh", trigger: "hover", selector: ".cell", stagger: "14ms" }]);
    expect(css).toContain(".react-ui-anim-waveh .cell:hover:nth-child(2) { animation-delay: calc(1 * 14ms); }");
  });

  it("emits NO ramp when `stagger` has no `selector` (a root has no siblings to step)", () => {
    const css = compileAnimationsCss([{ ...fade, name: "noramp", stagger: "14ms" }]);
    expect(css).not.toContain(":nth-child(");
    expect(css).toContain(".react-ui-anim-noramp { animation:"); // the base animation still emits
  });

  it("drops the ramp when `stagger` is an unsafe value (defense in depth), keeping the base rule", () => {
    const css = compileAnimationsCss([{ ...fade, name: "unsafe", selector: ".cell", stagger: "14ms; } body{" }]);
    expect(css).not.toContain(":nth-child(");
    expect(css).not.toContain("evil");
    expect(css).not.toContain("body{");
    expect(css).toContain(".react-ui-anim-unsafe .cell { animation:"); // the base animation still emits
  });

  it("emits no ramp (byte-identical to slice 1) when `stagger` is absent, even with a selector", () => {
    const withSelector = compileAnimationsCss([{ ...fade, name: "sel", selector: ".cell" }]);
    expect(withSelector).not.toContain(":nth-child(");
    // and a plain def is byte-identical to the slice-1 output
    const expected = `@keyframes bsc-react-ui-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: no-preference) {
  .react-ui-anim-fade-in { animation: bsc-react-ui-fade-in var(--dur-base) var(--ease-standard) 1 both; }
}`;
    expect(compileAnimationsCss([fade])).toBe(expected);
  });
});

describe("kitAnimations (#2942)", () => {
  it("flattens kits' motion libraries into defs keyed by the kit id", () => {
    const defs = kitAnimations([
      { id: "react-ui", animations: [{ name: "fade-in", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } } }] },
      { id: "empty-kit" }, // no animations → contributes nothing
    ]);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ kit: "react-ui", name: "fade-in" });
  });
});

describe("applyAnimationsToRoot (#2942)", () => {
  beforeEach(() => { document.getElementById("bsc-ui-animations")?.remove(); });

  it("injects the compiled CSS into a managed <style>, then removes it when cleared", () => {
    applyAnimationsToRoot([fade]);
    expect(document.getElementById("bsc-ui-animations")?.textContent).toContain("@keyframes bsc-react-ui-fade-in");
    applyAnimationsToRoot([]); // no renderable animation → the managed element is removed
    expect(document.getElementById("bsc-ui-animations")).toBeNull();
  });
});
