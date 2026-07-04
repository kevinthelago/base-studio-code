// Text — the one typographic primitive (#2057). Collapses the hand-rolled text-styling triad
// spread across the app: the ~1,100 inline `fontSize:` props, the ~945 inline `color:` props, and
// the 558 `className="mono"` sites — into one `<Text size tone mono weight>`.
//
// Every prop is opt-in and lossless: `size` takes a named rung ("sm"/"md"/…) OR a raw px number
// (the off-scale half-sizes stay reachable), `tone` is a SEMANTIC color enum (never a raw token),
// `mono` toggles the existing `mono` utility class (not an inline font-family). With no props it is
// a bare `<span>` that forces no size, color, or weight — so wrapping existing text never changes
// it. Any extra prop (onClick, title, htmlFor when as="label", data-*, …) passes straight through,
// and a `style` override wins last.

import type { CSSProperties, ReactNode, ElementType } from "react";
import { fontSize, toneColor, type TextSize, type Tone } from "./type";
import { Skeleton } from "@/shared/ui/feedback/Skeleton";

export interface TextProps {
  children?: ReactNode;
  /** Font size — a scale rung ("sm"/"md"/…) or raw px. Omit to inherit. */
  size?: TextSize;
  /** Semantic color tone ("dim"/"muted"/"accent"/"danger"/"success"). Omit to inherit. */
  tone?: Tone;
  /** Add the `mono` utility class (JetBrains Mono) rather than an inline font-family. */
  mono?: boolean;
  /** Font weight — a number (500/600/…) or a CSS keyword ("bold"/…). */
  weight?: CSSProperties["fontWeight"];
  /** The rendered element (default `"span"`; e.g. div/p/label/h1–h4). */
  as?: ElementType;
  /** Render LOADING (#2302): an inline shimmer line the height of the text. `loadingWidth` sets px width. */
  loading?: boolean;
  loadingWidth?: number | string;
  className?: string;
  style?: CSSProperties;
  /** Any other prop passes through to the rendered element. */
  [key: string]: unknown;
}

export function Text({ children, size, tone, mono, weight, as: As = "span", loading, loadingWidth, className, style, ...rest }: TextProps) {
  const fs = fontSize(size);
  const color = toneColor(tone);
  if (loading) {
    const h = typeof fs === "number" ? Math.round(fs) : 11;
    return <Skeleton w={loadingWidth ?? 72} h={h} radius={4} style={{ display: "inline-block", verticalAlign: "middle", ...style }} />;
  }
  return (
    <As
      className={mono ? `${className ?? ""} mono`.trim() : className}
      style={{
        ...(fs != null ? { fontSize: fs } : {}),
        ...(color != null ? { color } : {}),
        ...(weight != null ? { fontWeight: weight } : {}),
        ...style,
      }}
      {...rest}
    >
      {children}
    </As>
  );
}
