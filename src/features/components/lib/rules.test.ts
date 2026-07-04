import { describe, it, expect } from "vitest";
import { deriveRules, mergeRules, kitRules, toEslintRules, toEslintPreset, ruleMessage, ESCAPE_HATCH } from "./rules";
import { SEED_COMPONENTS } from "./seed";
import type { ComponentRecord, KitRule } from "./model";

const reactUi = SEED_COMPONENTS.filter((c) => c.kitId === "react-ui");

describe("kit lint rules → eslint preset (#2279)", () => {
  it("derives a forbid-element rule from each component's `wraps` hint", () => {
    const rules = deriveRules(reactUi);
    const byTarget = Object.fromEntries(rules.map((r) => [r.target, r]));
    // Button wraps "button", Field wraps "input" — the dogfooded anti-duplication rules.
    expect(byTarget.button?.use).toBe("Button");
    expect(byTarget.button?.derived).toBe(true);
    expect(byTarget.input?.use).toBe("Field");
    expect(rules.every((r) => r.kind === "forbid-element")).toBe(true); // wraps only derives element rules
  });

  it("ruleMessage names the replacement + carries the escape hatch", () => {
    const [r] = deriveRules(reactUi.filter((c) => c.wraps === "button"));
    const msg = ruleMessage(r);
    expect(msg).toContain("<Button>");
    expect(msg).toContain("<button>");
    expect(msg).toContain(ESCAPE_HATCH);
  });

  it("compiles forbid-element rules into a single no-restricted-syntax array", () => {
    const cfg = toEslintRules(deriveRules(reactUi));
    const syntax = cfg["no-restricted-syntax"] as unknown[];
    expect(syntax[0]).toBe("error");
    const selectors = (syntax.slice(1) as { selector: string }[]).map((s) => s.selector);
    expect(selectors).toContain("JSXOpeningElement[name.name='button']");
    expect(selectors).toContain("JSXOpeningElement[name.name='input']");
  });

  it("compiles forbid-import rules into no-restricted-imports paths", () => {
    const rule: KitRule = { id: "a", kind: "forbid-import", target: "@mui/material", use: "Button" };
    const cfg = toEslintRules([rule]);
    const imp = cfg["no-restricted-imports"] as [string, { paths: { name: string; message: string }[] }];
    expect(imp[0]).toBe("error");
    expect(imp[1].paths[0].name).toBe("@mui/material");
    expect(imp[1].paths[0].message).toContain("Button");
  });

  it("author-declared rules override a derived rule for the same (kind, target)", () => {
    const authored: KitRule = { id: "x", kind: "forbid-element", target: "button", use: "MyButton", message: "custom" };
    const merged = mergeRules(deriveRules(reactUi), [authored]);
    const forButton = merged.filter((r) => r.kind === "forbid-element" && r.target === "button");
    expect(forButton).toHaveLength(1); // no duplicate for the same target
    expect(forButton[0].use).toBe("MyButton");
    expect(forButton[0].derived).toBe(false);
  });

  it("kitRules gathers derived + each component's authored rules; toEslintPreset wraps it", () => {
    const withAuthored: ComponentRecord[] = [
      ...reactUi,
      { ...reactUi[0], id: "x", name: "X", wraps: undefined, rules: [{ id: "imp", kind: "forbid-import", target: "lodash", use: "utils" }] },
    ];
    const rules = kitRules(withAuthored);
    expect(rules.some((r) => r.kind === "forbid-import" && r.target === "lodash")).toBe(true);
    const preset = toEslintPreset(withAuthored);
    expect(preset.rules["no-restricted-syntax"]).toBeTruthy();
    expect(preset.rules["no-restricted-imports"]).toBeTruthy();
  });

  it("an empty kit yields an empty preset", () => {
    expect(toEslintPreset([])).toEqual({ rules: {} });
  });
});
