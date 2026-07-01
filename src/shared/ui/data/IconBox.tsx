// IconBox — the centered fixed-size icon/glyph square repeated across the planner modals + cards
// (#1882). Dedups the width/height/flex/center/border-radius boilerplate; size, radius, background,
// color, and the optional glyph styling (fontSize / fontWeight / border) stay props. Renders `mono`
// so a letter/glyph child sits right (an <Icon> component child is unaffected).
import type { ReactNode, CSSProperties } from "react";

export function IconBox({
  size = 30, radius = 7, background, color, fontSize, fontWeight = 700, border, className, style, children,
}: {
  size?: number;
  radius?: number;
  background?: string;
  color?: string;
  fontSize?: number;
  fontWeight?: number;
  /** A full `border` shorthand (e.g. `1px solid …`). */
  border?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <span
      className={className}
      style={{
        width: size, height: size, flex: `0 0 ${size}px`,
        display: "flex", alignItems: "center", justifyContent: "center",
        borderRadius: radius, fontFamily: "var(--mono)", fontWeight,
        ...(fontSize != null ? { fontSize } : {}),
        ...(background != null ? { background } : {}),
        ...(color != null ? { color } : {}),
        ...(border != null ? { border } : {}),
        ...style,
      }}
    >
      {children}
    </span>
  );
}
