import type { ReactNode, CSSProperties } from "react";
import "./sectionHeader.css";

export interface SectionHeaderProps {
  title: ReactNode;
  /** Dimmed inline sub-text after the title. */
  hint?: ReactNode;
  /** Right-aligned dim mono text (e.g. a count) — wrapped in the meta style. */
  meta?: ReactNode;
  /** Right-aligned raw content (e.g. a search input or button) — overrides `meta`. */
  right?: ReactNode;
  titleStyle?: CSSProperties;
  className?: string;
}

/** SectionHeader — the one uppercase section-title row: `title · hint · spacer · meta|right`.
 *  Absorbs the agents/mcp `.sec-head` (#1874). Planner's collapsible `.sec-head` (chev/count/hover)
 *  is a different component and is intentionally left alone. */
export function SectionHeader({ title, hint, meta, right, titleStyle, className }: SectionHeaderProps) {
  return (
    <div className={"section-header" + (className ? ` ${className}` : "")}>
      <h3 style={titleStyle}>{title}</h3>
      {hint != null && <span className="hint">{hint}</span>}
      {(right != null || meta != null) && <span className="sh-spacer" />}
      {right != null ? right : meta != null ? <span className="sh-meta">{meta}</span> : null}
    </div>
  );
}
