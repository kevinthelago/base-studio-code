// Eyebrow — the uppercase-mono micro-label (#2720). A thin wrapper over Text that fixes the
// one recurring recipe: mono + dim + uppercase + letter-spacing. It replaces the per-feature
// `.ds-eyebrow` / `.themes-eyebrow` CSS rules (which differed only in font-size), so `size`
// keeps each site's exact px (9.5 vs 10). Any extra prop (className, as, title, …) passes through.

import type { ReactNode, ElementType, CSSProperties } from "react";
import { Text } from "./Text";

export interface EyebrowProps {
  children?: ReactNode;
  /** Font size in px — keeps existing sites lossless (ds sites use 9.5, themes uses 10). */
  size?: number;
  /** The rendered element (default `"span"`). */
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  /** Any other prop passes straight through to Text. */
  [key: string]: unknown;
}

export function Eyebrow({ children, size = 10, as = "span", style, ...rest }: EyebrowProps) {
  return (
    <Text
      mono
      size={size}
      tone="dim"
      as={as}
      style={{ letterSpacing: ".08em", textTransform: "uppercase", ...style }}
      {...rest}
    >
      {children}
    </Text>
  );
}
