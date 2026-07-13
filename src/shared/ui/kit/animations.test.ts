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
