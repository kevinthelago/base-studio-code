// Kit lint rules → eslint preset (#2279) — the auto-firing enforcement a kit ships so an agent building
// an app on it can't quietly re-invent a component. This is the pure spine: the rule model lives in
// model.ts; here are the derivation (from each component's `wraps` hint), the author-declared merge, and
// the emitter that turns a kit's rules into plain eslint config (NO custom plugin — the dogfooded 80%).
//
// Config-level ONLY for now: `forbid-element` → `no-restricted-syntax` (the exact pattern this repo uses
// to force `<Box>`/`<Button>` over raw elements), `forbid-import` → `no-restricted-imports`. The
// generated app extends the emitted preset; every rule message carries the escape hatch so it teaches
// but allows a justified exception. Custom AST plugins, token rules, and non-eslint linters are follow-ups.
import type { ComponentRecord, KitRule } from "./model";

/** The escape-hatch clause every rule message ends with — enforce, but allow a justified exception. */
export const ESCAPE_HATCH = "If truly required, add `// eslint-disable-next-line <rule> -- <reason>`.";

/** The human message for a rule (its own `message`, else a default that names `use` + the escape hatch). */
export function ruleMessage(r: KitRule): string {
  if (r.message) return r.message;
  const base =
    r.kind === "forbid-element"
      ? `Use the kit's <${r.use}> instead of a raw <${r.target}>.`
      : `Import ${r.use} from the kit instead of "${r.target}".`;
  return `${base} ${ESCAPE_HATCH}`;
}

/** Derive the flagship anti-duplication rules from the kit: one `forbid-element` per component that
 *  declares what raw intrinsic it `wraps` ("use <Button> not a raw <button>"). */
export function deriveRules(components: ComponentRecord[]): KitRule[] {
  return components
    .filter((c) => c.wraps)
    .map((c) => ({
      id: `derived:forbid-element:${c.wraps}`,
      kind: "forbid-element" as const,
      target: c.wraps!,
      use: c.name,
      componentId: c.id,
      derived: true,
    }));
}

/** The dedup key for a rule — a kit shouldn't forbid the same target twice. */
const ruleKey = (r: KitRule) => `${r.kind}:${r.target}`;

/** Merge derived + author-declared rules: an authored rule OVERRIDES a derived one for the same
 *  (kind, target), and adds any new ones. Authored wins so a kit can refine a derived message/target. */
export function mergeRules(derived: KitRule[], authored: KitRule[]): KitRule[] {
  const byKey = new Map(derived.map((r) => [ruleKey(r), r]));
  for (const a of authored) byKey.set(ruleKey(a), { ...a, derived: false });
  return [...byKey.values()];
}

/** The full ruleset for a kit's components: the derived anti-duplication rules merged with every
 *  component's author-declared `rules`. */
export function kitRules(components: ComponentRecord[]): KitRule[] {
  const authored = components.flatMap((c) => c.rules ?? []);
  return mergeRules(deriveRules(components), authored);
}

/** The eslint `rules` fragment a kit's ruleset compiles to (only the rules that have entries appear). */
export interface EslintRulesConfig {
  "no-restricted-syntax"?: unknown[];
  "no-restricted-imports"?: unknown[];
}

/** Compile a ruleset into a plain eslint `rules` object — `forbid-element` rules fold into one
 *  `no-restricted-syntax` array (each a JSX-element selector + message); `forbid-import` rules into one
 *  `no-restricted-imports` `paths` list. */
export function toEslintRules(rules: KitRule[]): EslintRulesConfig {
  const syntax = rules
    .filter((r) => r.kind === "forbid-element")
    .map((r) => ({ selector: `JSXOpeningElement[name.name='${r.target}']`, message: ruleMessage(r) }));
  const imports = rules
    .filter((r) => r.kind === "forbid-import")
    .map((r) => ({ name: r.target, message: ruleMessage(r) }));

  const out: EslintRulesConfig = {};
  if (syntax.length) out["no-restricted-syntax"] = ["error", ...syntax];
  if (imports.length) out["no-restricted-imports"] = ["error", { paths: imports }];
  return out;
}

/** The eslint preset a kit ships — a flat-config fragment the generated app extends
 *  (`{ rules: { … } }`). Empty `rules` when the kit declares/derives nothing. */
export function toEslintPreset(components: ComponentRecord[]): { rules: EslintRulesConfig } {
  return { rules: toEslintRules(kitRules(components)) };
}
