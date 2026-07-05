// The kit THEME axis (#1852 Phase 3) — the third orthogonal axis of the UI kit (style × theme × spec).
// A theme is a map of overrides for the semantic component tokens (`--card-*`/`--btn-*`/`--field-*`/
// `--chip-*` in styles/tokens.css). Applying a theme just sets those CSS custom properties — globally
// on :root (`applyThemeToRoot`, the accent's mechanism) or scoped on a subtree (`<ThemeScope>`), so
// every `.card`/`.btn`/`.input`/`.chip` follows without touching any component's markup or a spec's
// structure. Registry loaded from the ONE source of truth (`@data/ui/themes.json`, also served by
// `bsc ui theme`). Pure (the root apply takes the element as a param) → unit-testable.

import type { CSSProperties } from "react";
import THEMES_DATA from "@data/ui/themes.json";

export interface KitTheme {
  /** Stable id persisted in the store + used by `bsc ui theme get`. */
  id: string;
  label: string;
  description: string;
  /** Semantic-token overrides — CSS var name → value. Empty for the base look. */
  vars: Record<string, string>;
}

/** Every built-in theme, in registry order (`default` first). */
export const KIT_THEMES: KitTheme[] = (THEMES_DATA as unknown as { themes: KitTheme[] }).themes;

export const DEFAULT_THEME = "default";

/** The theme for an id, falling back to `default` (so a corrupt persisted value can't blank the UI). */
export function themeById(id: string | undefined): KitTheme {
  return (
    KIT_THEMES.find((t) => t.id === id) ??
    KIT_THEMES.find((t) => t.id === DEFAULT_THEME) ??
    KIT_THEMES[0]
  );
}

/** A theme's overrides as a style object — spread onto a subtree's `style` for scoped application. */
export function themeVars(id: string | undefined): CSSProperties {
  return { ...themeById(id).vars } as CSSProperties;
}

/** The union of every token any theme touches — the set to CLEAR when switching, so a prior theme's
 *  overrides don't linger after moving to one that doesn't set them. */
export const KIT_TOKENS: string[] = Array.from(
  new Set(KIT_THEMES.flatMap((t) => Object.keys(t.vars))),
);

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
  for (const token of KIT_TOKENS) {
    if (token in vars) root.style.setProperty(token, vars[token]);
    else root.style.removeProperty(token);
  }
}
