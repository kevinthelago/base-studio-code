// RailGroupHeader (#2789) — the ONE section sub-label above a group of RailRows. Standardizes the
// four drifted group headers (Algorithms per-kind, Teams per-department, Designs `.ds-grouphead`,
// Skills "⬡ Groups" / facet titles) onto the shared SectionLabel micro-label, with an optional
// trailing count, an optional right-aligned action, and an optional collapse caret (Designs tree).
import type { CSSProperties, ReactNode } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import "./rail.css";

export interface RailGroupHeaderProps {
  /** The group label (rendered as the uppercase mono micro-label). */
  children: ReactNode;
  /** Right-aligned member count (dim mono). */
  count?: ReactNode;
  /** Render a leading disclosure caret and make the whole header a toggle button. */
  collapsible?: boolean;
  /** Caret open state (when `collapsible`). */
  open?: boolean;
  /** Toggle handler (when `collapsible`). */
  onToggle?: () => void;
  /** Right-aligned action beside the count (e.g. Skills' "＋ New group"). */
  action?: ReactNode;
  /** Label size in px. Default 9.5. */
  size?: number;
  /** Tooltip (e.g. Designs' "technology: React" / "visual language: …"). */
  title?: string;
  /** Extra class (a page test/selector hook, e.g. Designs' `ds-grouphead`). */
  className?: string;
  style?: CSSProperties;
}

/** A left-rail section header. See {@link RailGroupHeaderProps}. */
export function RailGroupHeader({
  children, count, collapsible, open, onToggle, action, size = 9.5, title, className, style,
}: RailGroupHeaderProps) {
  const cls = `rail-grouphead${className ? ` ${className}` : ""}`;
  const right = count != null || action != null ? (
    <Row gap={8} align="center">
      {count != null && <Text as="span" mono size={10} tone="dim">{count}</Text>}
      {action}
    </Row>
  ) : null;

  if (collapsible) {
    return (
      <Box as="button" className={cls} aria-expanded={open} onClick={onToggle} title={title} style={style}>
        <Box as="span" className={`rail-caret${open ? " open" : ""}`}>▸</Box>
        <SectionLabel size={size} style={{ flex: 1 }}>{children}</SectionLabel>
        {right}
      </Box>
    );
  }
  return (
    <Box className={cls} title={title} style={style}>
      <SectionLabel size={size} right={right ?? undefined} style={{ flex: 1 }}>{children}</SectionLabel>
    </Box>
  );
}
