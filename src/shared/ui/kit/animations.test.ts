import { describe, it, expect, beforeEach } from "vitest";
import { compileAnimationsCss, applyAnimationsToRoot, componentAnimations, type AnimationDef } from "./animations";

const fade: AnimationDef = {
  component: "card",
  name: "fade-in",
  keyframes: { from: { opacity: "0" }, to: { opacity: "1" } },
};

describe("compileAnimationsCss (#2867)", () => {
  it("emits a @keyframes block + a reduced-motion-guarded applying rule, defaulting to the motion tokens", () => {
    const css = compileAnimationsCss([fade]);
    expect(css).toContain("@keyframes bsc-card-fade-in {");
    expect(css).toContain("from {");
    expect(css).toContain("opacity: 0;");
    expect(css).toContain("@media (prefers-reduced-motion: no-preference) {");
    // default duration/easing are the #2866 motion tokens; played once, class .<component>-anim-<name>
    expect(css).toContain(".card-anim-fade-in { animation: bsc-card-fade-in var(--dur-base) var(--ease-standard) 1 both; }");
  });

  it("honors the trigger and explicit duration/easing", () => {
    const hov = compileAnimationsCss([{ ...fade, name: "pulse", trigger: "hover", duration: "120ms", easing: "var(--ease-emphasized)" }]);
    expect(hov).toContain(".card-anim-pulse:hover { animation: bsc-card-pulse 120ms var(--ease-emphasized) 1 both; }");
    const loop = compileAnimationsCss([{ ...fade, name: "spin", trigger: "always" }]);
    expect(loop).toContain(".card-anim-spin { animation: bsc-card-spin var(--dur-base) var(--ease-standard) infinite both; }");
  });

  it("skips unsafe input — bad component/name, stop, property, or injection value (defense in depth)", () => {
    expect(compileAnimationsCss([{ ...fade, component: "Card" }])).toBe("");                       // uppercase component
    expect(compileAnimationsCss([{ ...fade, name: "fade;}evil" }])).toBe("");                      // unsafe name
    expect(compileAnimationsCss([{ component: "card", name: "x", keyframes: { from: { opacity: "1; } a{" } } }])).toBe(""); // injection value
    expect(compileAnimationsCss([{ component: "card", name: "x", keyframes: { "999%extra": { opacity: "1" } } }])).toBe(""); // bad stop
    expect(compileAnimationsCss([])).toBe("");
  });
});

describe("componentAnimations (#2867)", () => {
  it("flattens records' authored animations, keyed by the lowercased component name", () => {
    const defs = componentAnimations([
      { name: "Card", animations: [{ name: "fade-in", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } } }] },
      { name: "Chip" }, // no animations → contributes nothing
    ]);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ component: "card", name: "fade-in" });
  });
});

describe("applyAnimationsToRoot (#2867)", () => {
  beforeEach(() => { document.getElementById("bsc-ui-animations")?.remove(); });

  it("injects the compiled CSS into a managed <style>, then removes it when cleared", () => {
    applyAnimationsToRoot([fade]);
    expect(document.getElementById("bsc-ui-animations")?.textContent).toContain("@keyframes bsc-card-fade-in");
    applyAnimationsToRoot([]); // no renderable animation → the managed element is removed
    expect(document.getElementById("bsc-ui-animations")).toBeNull();
  });
});
