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
