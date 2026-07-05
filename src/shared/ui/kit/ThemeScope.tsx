// ThemeScope (#1852 Phase 3) — apply a kit theme to a SUBTREE. Sets the theme's semantic-token
// overrides on a wrapper element, so every `.card`/`.btn`/`.input`/`.chip` inside follows while the
// rest of the app keeps the global theme. This is what lets a themed card coexist with the default UI
// and what isolates a live preview (the Design Studio renders the same spec under a chosen theme
// without disturbing the surrounding chrome). The global equivalent is `applyThemeToRoot`.

import type { ReactNode, CSSProperties } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { themeVars } from "./theme";

export interface ThemeScopeProps {
  /** The kit theme id (falls back to `default`). */
  theme: string;
  children: ReactNode;
  className?: string;
  /** Extra style — wins over the theme vars. */
  style?: CSSProperties;
}

/** Wrap `children` in a subtree scoped to `theme`. */
export function ThemeScope({ theme, children, className, style }: ThemeScopeProps) {
  return (
    <Box className={className} style={{ ...themeVars(theme), ...style }} data-kit-theme={theme}>
      {children}
    </Box>
  );
}
