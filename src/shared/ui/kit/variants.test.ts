import { describe, it, expect } from "vitest";
import { compileVariantsCss, applyVariantsToRoot, type VariantDef } from "./variants";

const def = (over: Partial<VariantDef> = {}): VariantDef => ({
  id: "btn:danger-outline",
  component: "btn",
  variant: "danger-outline",
  tokens: { bg: "var(--danger)", fg: "var(--fg)", border: "var(--danger)" },
  ...over,
});

describe("compileVariantsCss (#2569)", () => {
  it("compiles a definition into a `.component.variant` rule setting its tokens", () => {
    const css = compileVariantsCss([def()]);
    expect(css).toContain(".btn.danger-outline {");
    expect(css).toContain("--btn-bg: var(--danger);");
    expect(css).toContain("--btn-fg: var(--fg);");
    expect(css).toContain("--btn-border: var(--danger);");
  });

  it("skips (defense-in-depth) an unsafe name, key, or injection value", () => {
    // unsafe variant/component name → no rule
    expect(compileVariantsCss([def({ variant: "Danger" })])).toBe("");
    expect(compileVariantsCss([def({ component: "b}d" })])).toBe("");
    // an injection value is dropped; a safe sibling token still renders
    const css = compileVariantsCss([def({ tokens: { bg: "red; }", fg: "var(--fg)" } })]);
    expect(css).not.toContain("red;");
    expect(css).toContain("--btn-fg: var(--fg);");
    // a definition with only unsafe values renders no rule
    expect(compileVariantsCss([def({ tokens: { bg: "url(evil)" } })])).toBe("");
  });
});

describe("applyVariantsToRoot (#2569)", () => {
  it("injects, updates, and clears the managed <style>", () => {
    const doc = document.implementation.createHTMLDocument("t");
    applyVariantsToRoot([def()], doc);
    const el = doc.getElementById("bsc-ui-variants");
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain(".btn.danger-outline");
    // update in place (same element, new content)
    applyVariantsToRoot([def({ tokens: { bg: "var(--accent)" } })], doc);
    expect(doc.querySelectorAll("#bsc-ui-variants")).toHaveLength(1);
    expect(doc.getElementById("bsc-ui-variants")!.textContent).toContain("--btn-bg: var(--accent);");
    // clearing (no defs) removes the element
    applyVariantsToRoot([], doc);
    expect(doc.getElementById("bsc-ui-variants")).toBeNull();
  });
});
