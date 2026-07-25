// ThemeProvider (#3715, follow-up to #3711) — provide the active theme as CONCRETE token VALUES to a
// subtree. The JS counterpart to <ThemeScope> (which sets CSS custom properties): a component that renders
// to a NON-CSS surface (canvas / WebGL / a non-web runtime) can't see the cascade, so it reads the resolved
// values via useResolvedTheme(). GraphComponent wraps a `themeSystem: "js"` component in this (the
// conditional render). Outside a provider the hook resolves the base theme, so a component works standalone
// — mirroring how a CSS component inherits the `:root` defaults when no <ThemeScope> is around it.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_THEME } from "./theme";
import { resolveThemeTokens } from "./resolve";

export interface ResolvedTheme {
  /** The theme id these values were resolved from. */
  themeId: string;
  /** Every contract token → its CONCRETE value (every `var(--x)` chain flattened). */
  tokens: Record<string, string>;
}

/** The base-theme resolution — the value the hook returns with NO provider (standalone). Computed once. */
const BASE_RESOLVED: ResolvedTheme = { themeId: DEFAULT_THEME, tokens: resolveThemeTokens(DEFAULT_THEME) };

const ThemeContext = createContext<ResolvedTheme | null>(null);

/** Provide the active theme's CONCRETE token values to `children`. `themeId` selects the theme (defaults to
 *  the base look). Re-resolves only when `themeId` changes. */
export function ThemeProvider({ themeId, children }: { themeId?: string; children: ReactNode }) {
  const id = themeId ?? DEFAULT_THEME;
  const value = useMemo<ResolvedTheme>(
    () => (id === DEFAULT_THEME ? BASE_RESOLVED : { themeId: id, tokens: resolveThemeTokens(id) }),
    [id],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** The active theme as concrete token values. Outside a {@link ThemeProvider} it resolves the base
 *  (`default`) theme, so a non-CSS component works standalone. */
export function useResolvedTheme(): ResolvedTheme {
  return useContext(ThemeContext) ?? BASE_RESOLVED;
}
