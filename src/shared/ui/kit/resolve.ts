// The resolver (#2637, epic #2606) — the SEAM that composes a theme's overrides over the token
// contract with PROVENANCE + LOUD diagnostics. The applied `vars` are byte-identical to `themeVars`
// today: the contract defaults already live on `:root` via `tokens.css`, so a scope only carries the
// overrides — ZERO visual change. The value it adds is OBSERVABILITY: which tokens a theme governs, and
// any HOLE — a theme var whose value references a `var(--token)` the contract does NOT define, a silent
// no-op the CSS cascade would swallow. `ThemeScope` calls this so a malformed theme YELPS in the log
// instead of failing silently (the fall-loudly principle). The generated + user-override layers slot in
// here in later slices; today the composition is theme-over-default.
import type { CSSProperties } from "react";
import DESCRIPTOR from "@data/ui/style-descriptor.json";
import { themeById, themeVars } from "./theme";

interface DescriptorShape {
  base?: { name: string }[];
  components?: { tokens?: { name: string }[]; variants?: { tokens?: { name: string }[] }[] }[];
  domain?: { tokens?: { name: string }[] }[];
}

/** Every token NAME the style-descriptor defines (base + component + per-variant + domain) — the set a
 *  theme value may legitimately reference. A `var(--X)` outside it is an uncontracted hole. Computed once. */
export const CONTRACT_TOKENS: ReadonlySet<string> = (() => {
  const d = DESCRIPTOR as DescriptorShape;
  const names = new Set<string>();
  for (const b of d.base ?? []) names.add(b.name);
  for (const c of d.components ?? []) {
    for (const t of c.tokens ?? []) names.add(t.name);
    for (const v of c.variants ?? []) for (const t of v.tokens ?? []) names.add(t.name);
  }
  for (const g of d.domain ?? []) for (const t of g.tokens ?? []) names.add(t.name);
  return names;
})();

/** The `var(--token)` names a CSS value references. */
export function referencedTokens(value: string): string[] {
  const out: string[] = [];
  const re = /var\(\s*(--[a-z0-9-]+)/gi;
  for (let m = re.exec(value); m; m = re.exec(value)) out.push(m[1]);
  return out;
}

/** The HOLES in a theme's `vars` (#2606 fall-loudly): every `var(--X)` a value references where `--X`
 *  is NOT a contract token — a silent no-op the cascade swallows. Sorted + deduped; pure. */
export function themeHoles(vars: Record<string, unknown>): string[] {
  const holes = new Set<string>();
  for (const value of Object.values(vars)) {
    for (const ref of referencedTokens(String(value))) {
      if (!CONTRACT_TOKENS.has(ref)) holes.add(ref);
    }
  }
  return [...holes].sort();
}

export interface ResolvedTheme {
  /** The overrides to apply on a scope / `:root` — byte-identical to `themeVars(id)` (zero visual change). */
  vars: CSSProperties;
  /** Each token the theme governs → "theme". Tokens absent here resolve from the contract default via
   *  the cascade (provenance "default"), so the map is exactly the theme's override set. */
  provenance: Record<string, "theme">;
  /** Uncontracted tokens referenced by the theme's values (holes) — empty when the theme is clean. */
  holes: string[];
}

/** Resolve `themeId` into its applied vars + provenance + holes. Pure. */
export function resolveTheme(themeId: string | undefined): ResolvedTheme {
  const raw = (themeById(themeId).vars ?? {}) as Record<string, unknown>;
  const provenance: Record<string, "theme"> = {};
  for (const token of Object.keys(raw)) provenance[token] = "theme";
  return { vars: themeVars(themeId), provenance, holes: themeHoles(raw) };
}
