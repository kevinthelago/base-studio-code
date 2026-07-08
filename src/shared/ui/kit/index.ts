// The themeable kit (#1852 Phases 0/1/3) — public barrel. The semantic component tokens live in
// styles/tokens.css; this module is the THEME axis over them: the registry + apply helpers + the
// scoped wrapper. See also `@/shared/ui/spec` (the SPEC axis — KitNode + KitRenderer).

export type { KitTheme } from "./theme";
export {
  KIT_THEMES, DEFAULT_THEME, KIT_TOKENS, themeById, themeVars, applyThemeToRoot,
  // #2488: the designer-writable theme store's sync hooks — the components slice hydrate pushes the
  // store collection in; every themeById/themeVars/ThemeScope consumer then resolves against it.
  setActiveKitThemes, activeKitThemes, kitTokens,
} from "./theme";
export { ThemeScope } from "./ThemeScope";
export type { ThemeScopeProps } from "./ThemeScope";
// #2569: data-defined component variants — compile the designer-authored variant store into a managed
// `<style>` of `.<component>.<variant>` rules (the render path for `bsc ui component … define-variant`).
export type { VariantDef } from "./variants";
export { compileVariantsCss, applyVariantsToRoot } from "./variants";
