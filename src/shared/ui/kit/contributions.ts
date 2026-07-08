// Design contributions overlay (#2650, epic #2606 slice 5b-1) — the compose-don't-MUTATE application of
// the design tokens a downloaded blueprint contributes. When reconciliation (#2646) fills a blueprint's
// missing categories via the generator (#2636), the generated `--graph-category-<key>: <colour>` tokens
// are REGISTERED as a contribution (provenance = the blueprint), never written into the shared contract
// — `tokens.css` / the descriptor stay untouched. This compiles the registered contributions into ONE
// managed `<style>` of `:root` custom properties, so removing a blueprint drops exactly its overlay with
// no contract file touched. Mirrors the variant overlay (variants.ts) + applyThemeToRoot.
//
// DEFENSE IN DEPTH: the values come from the generator + are stored data, but this compiles them into
// live CSS, so a token NAME must be a safe custom property and a VALUE must not contain a
// declaration-ending / injection sequence. Anything failing is skipped, never emitted.

/** One design contribution — the generated tokens a source (a blueprint) adds to the running app. */
export interface DesignContributionOverlay {
  /** Provenance — the blueprint id the tokens came from, so removing it drops exactly these. */
  source: string;
  /** Full custom-property name (e.g. `--graph-category-simulation`) → value (an oklch/hex colour). */
  tokens: Record<string, string>;
}

const STYLE_ID = "bsc-ui-contributions";
/** A full custom-property name: `--` + a safe identifier tail. */
const SAFE_TOKEN = /^--[a-z][a-z0-9-]*$/;
/** A value that could END the declaration or INJECT CSS — refused (defense in depth). */
const UNSAFE_VALUE = /[;{}<>\\]|url\(|expression\(|@import|\/\*/i;

/** The contract token name a graph-category key fills (#2650): `simulation` → `--graph-category-simulation`. */
export function graphCategoryToken(key: string): string {
  return `--graph-category-${key}`;
}

/** Shape a source's generated category colours into an applicable overlay (#2650): each
 *  `{ category → colour }` becomes its `--graph-category-<key>` token. Colours come from the generator
 *  (`bsc ui generate`) at confirm time; this only maps them. Pure. */
export function contributionFromCategories(source: string, colors: Record<string, string>): DesignContributionOverlay {
  const tokens: Record<string, string> = {};
  for (const [key, color] of Object.entries(colors)) tokens[graphCategoryToken(key)] = color;
  return { source, tokens };
}

/** Compile contributions into ONE `:root { … }` block of custom-property declarations. Pure + guarded:
 *  skips any token whose NAME isn't a safe custom property or whose VALUE looks like an injection; on a
 *  duplicate token the LAST source wins. Empty string when nothing is renderable. */
export function compileContributionsCss(overlays: DesignContributionOverlay[]): string {
  const decls = new Map<string, string>();
  for (const o of overlays ?? []) {
    for (const [name, value] of Object.entries(o?.tokens ?? {})) {
      if (SAFE_TOKEN.test(name) && typeof value === "string" && value && !UNSAFE_VALUE.test(value)) {
        decls.set(name, value);
      }
    }
  }
  if (decls.size === 0) return "";
  return `:root {\n${[...decls].map(([name, value]) => `  ${name}: ${value};`).join("\n")}\n}`;
}

/** Inject / update / clear the managed `<style id="bsc-ui-contributions">`. Removing all contributions
 *  removes the element (the contract's own defaults resume). `doc` is param'd for tests. */
export function applyContributionsToRoot(overlays: DesignContributionOverlay[], doc: Document = document): void {
  const css = compileContributionsCss(overlays);
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
