// The themeable kit (#1852 Phases 0/1/3) — public barrel. The semantic component tokens live in
// styles/tokens.css; this module is the THEME axis over them: the registry + apply helpers + the
// scoped wrapper. See also `@/shared/ui/spec` (the SPEC axis — KitNode + KitRenderer).

export type { KitTheme } from "./theme";
export { KIT_THEMES, DEFAULT_THEME, KIT_TOKENS, themeById, themeVars, applyThemeToRoot } from "./theme";
export { ThemeScope } from "./ThemeScope";
export type { ThemeScopeProps } from "./ThemeScope";
