// ThemeScope (#1852 Phase 3) — apply a kit theme to a SUBTREE. Sets the theme's semantic-token
// overrides on a wrapper element, so every `.card`/`.btn`/`.input`/`.chip` inside follows while the
// rest of the app keeps the global theme. This is what lets a themed card coexist with the default UI
// and what isolates a live preview (the Design Studio renders the same spec under a chosen theme
// without disturbing the surrounding chrome). The global equivalent is `applyThemeToRoot`.

import { useEffect, type ReactNode, type CSSProperties } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { log } from "@/shared/lib/core/log";
import { resolveTheme } from "./resolve";

export interface ThemeScopeProps {
  /** The kit theme id (falls back to `default`). */
  theme: string;
  children: ReactNode;
  className?: string;
  /** Extra style — wins over the theme vars. */
  style?: CSSProperties;
}

/** Wrap `children` in a subtree scoped to `theme`. Resolver-aware (#2637): the applied vars are
 *  identical to `themeVars` (zero visual change), but a theme referencing an UNCONTRACTED token —
 *  a silent no-op in the cascade — yelps in the log (the fall-loudly principle), once per theme×holes. */
export function ThemeScope({ theme, children, className, style }: ThemeScopeProps) {
  const { vars, holes } = resolveTheme(theme);
  const holesKey = holes.join(", ");
  useEffect(() => {
    if (holesKey) {
      log.warn(`theme '${theme || "default"}' references uncontracted token(s): ${holesKey}`, "design");
    }
  }, [theme, holesKey]);
  return (
    <Box className={className} style={{ ...vars, ...style }} data-kit-theme={theme}>
      {children}
    </Box>
  );
}
