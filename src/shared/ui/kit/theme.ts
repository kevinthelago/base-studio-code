// The kit THEME axis (#1852 Phase 3) — the third orthogonal axis of the UI kit (style × theme × spec).
// A theme is a map of overrides for the semantic component tokens (`--card-*`/`--btn-*`/`--field-*`/
// `--chip-*` in styles/tokens.css). Applying a theme just sets those CSS custom properties — globally
// on :root (`applyThemeToRoot`, the accent's mechanism) or scoped on a subtree (`<ThemeScope>`), so
// every `.card`/`.btn`/`.input`/`.chip` follows without touching any component's markup or a spec's
// structure.
//
// TWO sources compose here (#2488): the PACKAGED registry (`@data/ui/themes.json`, also embedded by
// `bsc ui theme`) is the boot fallback, and the designer-writable theme STORE (hydrated on boot by the
// components slice via `bsc ui theme list --full`) is the live set once reachable. The hydrate pushes
// the store's collection in through `setActiveKitThemes`, so every consumer of `themeById`/`themeVars`/
// `applyThemeToRoot`/`<ThemeScope>` resolves against the SAME set without importing the Zustand store
// (which would cycle: store → features → shared). Pure (the root apply takes the element as a param)
// → unit-testable.

import type { CSSProperties } from "react";
import THEMES_DATA from "@data/ui/themes.json";

export interface KitTheme {
  /** Stable id persisted in the store + used by `bsc ui theme get`. */
  id: string;
  label: string;
  description: string;
  /** The SURFACE the theme sits on (#2545). Absent ⇒ `"dark"` (the historical base). The Design
   *  Studio preview reads this to pick its sandbox surface, so light/dark is theme data (seeded in
   *  `@data/ui/themes.json`, then served by `bsc ui theme`) rather than a hardcoded toggle. */
  base?: "dark" | "light";
  /** Semantic-token overrides — CSS var name → value. Empty for the base look. */
  vars: Record<string, string>;
}

/** The PACKAGED built-in themes, in registry order (`default` first) — the boot fallback (#2488). */
export const KIT_THEMES: KitTheme[] = (THEMES_DATA as unknown as { themes: KitTheme[] }).themes;

export const DEFAULT_THEME = "default";

/** The live theme set: the hydrated store collection once `setActiveKitThemes` ran, else packaged. */
let activeThemes: KitTheme[] = KIT_THEMES;

/** Sync the hydrated store collection in (#2488). An empty array resets to the packaged registry, so
 *  a degenerate hydrate can never blank every theme. Called by the components slice's
 *  `hydrateThemes`; tests call it directly (and reset with `setActiveKitThemes([])`). */
export function setActiveKitThemes(themes: KitTheme[]): void {
  activeThemes = themes.length ? themes : KIT_THEMES;
}

/** The current theme set — hydrated store themes when available, else the packaged registry. */
export function activeKitThemes(): KitTheme[] {
  return activeThemes;
}

/** The theme for an id, falling back to `default` (so a corrupt persisted value can't blank the UI).
 *  Resolves against the live set first, then the packaged registry (the hydrated set always contains
 *  the built-ins — the reconcile re-seeds them — so the packaged hop is a belt-and-braces fallback). */
export function themeById(id: string | undefined): KitTheme {
  return (
    activeThemes.find((t) => t.id === id) ??
    activeThemes.find((t) => t.id === DEFAULT_THEME) ??
    KIT_THEMES.find((t) => t.id === DEFAULT_THEME) ??
    KIT_THEMES[0]
  );
}

/** A theme's overrides as a style object — spread onto a subtree's `style` for scoped application. */
export function themeVars(id: string | undefined): CSSProperties {
  return { ...themeById(id).vars } as CSSProperties;
}

/** The union of every token any PACKAGED theme touches. Kept for compatibility; the apply path uses
 *  {@link kitTokens}, which also covers store-authored themes. */
export const KIT_TOKENS: string[] = Array.from(
  new Set(KIT_THEMES.flatMap((t) => Object.keys(t.vars))),
);

/** The union of every token any CURRENT theme (live set ∪ packaged) touches — the set to CLEAR when
 *  switching, so a prior theme's overrides don't linger after moving to one that doesn't set them. */
export function kitTokens(): string[] {
  return Array.from(
    new Set([...activeThemes, ...KIT_THEMES].flatMap((t) => Object.keys(t.vars))),
  );
}

/**
 * Apply a theme GLOBALLY by writing its overrides to a root element's inline style — and clearing any
 * kit token a prior theme set that this one doesn't, so switching fully resets to the stylesheet
 * defaults. Mirrors the accent apply in `useAppBoot`.
 *
 * @param id - the theme id (falls back to `default`)
 * @param root - the element to write to (defaults to `document.documentElement`; param'd for tests)
 */
export function applyThemeToRoot(id: string | undefined, root: HTMLElement = document.documentElement): void {
  const { vars } = themeById(id);
  for (const token of kitTokens()) {
    if (token in vars) root.style.setProperty(token, vars[token]);
    else root.style.removeProperty(token);
  }
}
