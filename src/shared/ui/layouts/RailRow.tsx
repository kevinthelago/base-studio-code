// RailRow (#2789) — the ONE nav row for every left-pane menu. Replaces the four hand-rolled rows
// (Algorithms `.algo-railrow`, Teams `.teams-railrow`, Designs `.ds-kithead`/`.ds-comprow`, Skills
// inline `<Row>`) with a single slotted primitive: a leading indicator (dot/icon/swatch/glyph/
// checkbox), an ellipsized label, and a trailing count/badge/action — with one canonical hover +
// selected look. Optional `caret`/`indent` cover the Designs collapsible tree. Sibling of GraphRail.
import type { CSSProperties, ReactNode, MouseEvent, ComponentPropsWithoutRef } from "react";
import { Box } from "@/shared/ui/layout/Box";
import "./rail.css";

export interface RailRowProps
  extends Omit<ComponentPropsWithoutRef<"div">, "onClick" | "title" | "style" | "children"> {
  /** Selected state — applies the canonical `.on` wash. */
  active?: boolean;
  onClick?: (e: MouseEvent) => void;
  /** Leading slot: a color dot / IconBox / ColorSwatch / RoleDot / glyph / Checkbox. */
  leading?: ReactNode;
  /** Trailing slot: a dim count, a badge, or an inline action (e.g. a delete ✕). */
  trailing?: ReactNode;
  /** When defined, a leading disclosure caret is shown; the value is its open state (expandable rows). */
  caret?: boolean;
  /** Tree nesting depth (0-based) → left padding, for tree rails (Designs kit → component rows). */
  indent?: number;
  /** Label font-weight (Designs kit heads use 500). Default inherits the row's. */
  weight?: number;
  title?: string;
  style?: CSSProperties;
  /** The label — ellipsized to one line. */
  children: ReactNode;
}

/** A single left-rail navigation row. See {@link RailRowProps}. Renders a `<button>` (keyboard-
 *  focusable); nested affordances in the `trailing`/`leading` slots must be non-`<button>` (spans). */
export function RailRow({
  active, onClick, leading, trailing, caret, indent, weight, title, className, style, children, ...rest
}: RailRowProps) {
  return (
    <Box
      as="button"
      title={title}
      onClick={onClick}
      className={`rail-row${active ? " on" : ""}${className ? ` ${className}` : ""}`}
      style={indent ? { paddingLeft: 8 + indent * 14, ...style } : style}
      {...rest}
    >
      {caret !== undefined && <Box as="span" className={`rail-caret${caret ? " open" : ""}`}>▸</Box>}
      {leading != null && <Box as="span" className="rail-row-lead">{leading}</Box>}
      <Box as="span" className="rail-row-label" style={weight ? { fontWeight: weight } : undefined}>{children}</Box>
      {trailing != null && <Box as="span" className="rail-row-trail">{trailing}</Box>}
    </Box>
  );
}
