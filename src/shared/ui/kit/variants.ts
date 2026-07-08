// Data-defined component variants (#2569 rung 3) — the RENDER path for variants an LLM authors with
// `bsc ui component <c> define-variant`. Each stored definition is a token bundle for a
// `<component>:<variant>`; this compiles them into ONE managed `<style>` of `.<component>.<variant>`
// rules that set the component's semantic tokens, so an authored variant restyles the real component
// with zero component changes (the primitive already adds the variant string as a class — a new variant
// is pure DATA). Applied globally on boot + re-applied on a `ui-touch` "variant" write (live, #2525).
//
// DEFENSE IN DEPTH: the CLI already sanitises the name + grammar-checks each value (crates/bsc-ui), but
// this compiles LLM-authored data into live CSS, so we re-validate here — a variant/component name must
// be a safe CSS identifier and a value must not contain a declaration-ending / injection sequence.
// Anything failing is skipped, never emitted.

/** One stored variant definition — the shape `bsc ui variants` returns. */
export interface VariantDef {
  /** `<component>:<variant>` (the store id). */
  id: string;
  component: string;
  variant: string;
  /** Short token key (e.g. `bg`) → value (a `var(--x)` / colour / dimension). */
  tokens: Record<string, string>;
}

const STYLE_ID = "bsc-ui-variants";
/** A safe CSS identifier for a class selector segment (mirrors the CLI's sanitize_variant_name). */
const SAFE_IDENT = /^[a-z][a-z0-9-]*$/;
/** A value that could END the declaration or INJECT CSS — refused even though the CLI already guards. */
const UNSAFE_VALUE = /[;{}<>\\]|url\(|expression\(|@import|\/\*/i;

/**
 * Compile variant definitions into CSS: one `.<component>.<variant> { --<component>-<key>: <value>; … }`
 * rule per definition. Pure + guarded — skips any definition whose component/variant name isn't a safe
 * identifier and any token whose value looks like an injection. Empty string when nothing is renderable.
 */
export function compileVariantsCss(defs: VariantDef[]): string {
  const rules: string[] = [];
  for (const d of defs) {
    if (!d || !SAFE_IDENT.test(d.component ?? "") || !SAFE_IDENT.test(d.variant ?? "")) continue;
    const decls = Object.entries(d.tokens ?? {})
      .filter(([key, value]) => SAFE_IDENT.test(key) && typeof value === "string" && !UNSAFE_VALUE.test(value))
      .map(([key, value]) => `  --${d.component}-${key}: ${value};`);
    if (decls.length) rules.push(`.${d.component}.${d.variant} {\n${decls.join("\n")}\n}`);
  }
  return rules.join("\n\n");
}

/**
 * Inject / update / clear the managed `<style id="bsc-ui-variants">` holding the compiled variant CSS.
 * Removing the last variant removes the element. `doc` is param'd for tests. Mirrors the accent/theme
 * root-apply — one global stylesheet the whole app follows.
 */
export function applyVariantsToRoot(defs: VariantDef[], doc: Document = document): void {
  const css = compileVariantsCss(defs);
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = doc.createElement("style");
    el.id = STYLE_ID;
    doc.head.appendChild(el);
  }
  el.textContent = css;
}
