import type { ReactNode, CSSProperties } from "react";
import { clickable } from "@/shared/ui/a11y";
import "./cardListRow.css";

export interface CardListRowProps {
  /** The 18px lead column — a status dot, icon, or avatar. */
  lead?: ReactNode;
  /** Primary label. */
  title: ReactNode;
  /** A pill rendered next to the title (left of the spacer). */
  badge?: ReactNode;
  /** A right-aligned element on the title line — a control or badge pushed to the right. */
  titleAside?: ReactNode;
  /** Secondary line under the title. */
  subtitle?: ReactNode;
  /** Full-width rich content below the header line (e.g. a wrapping chip list). */
  body?: ReactNode;
  /** The trailing (auto-width) column — chips, counts, controls, a toggle. */
  trailing?: ReactNode;
  /** Selection highlight. */
  selected?: boolean;
  /** Dimmed/disabled look. */
  off?: boolean;
  /** "card" (default) = bordered card; "grouped" = no border, top-separator, inherits the parent bg. */
  variant?: "card" | "grouped";
  /** A left-rail accent colour, shown when the row is `selected` (e.g. a profile colour). */
  accent?: string;
  onClick?: () => void;
  className?: string;
}

/** CardListRow — the selectable card-list row: a `[lead · title+badge / subtitle · trailing]` bordered
 *  card. The card-list archetype of the row vocabulary (#1865); its sibling is <DataTableRow> for
 *  columnar tables. Every card-list (mcp servers/hooks, agent profiles, …) composes this with its own
 *  slot content, so the kit/SDK emits one row shape rather than N bespoke rows. */
export function CardListRow({ lead, title, badge, titleAside, subtitle, body, trailing, selected, off, variant = "card", accent, onClick, className }: CardListRowProps) {
  return (
    <div
      className={
        "card-list-row" +
        (variant === "grouped" ? " grouped" : "") +
        (body != null ? " has-body" : "") +
        (accent != null ? " has-accent" : "") +
        (onClick ? " clickable" : "") +
        (selected ? " selected" : "") +
        (off ? " off" : "") +
        (className ? ` ${className}` : "")
      }
      style={accent != null ? ({ ["--clr-accent" as string]: accent } as CSSProperties) : undefined}
      {...clickable(onClick)}
    >
      <div className="clr-lead">{lead}</div>
      <div className="clr-main">
        <div className="clr-line1">
          <span className="clr-name">{title}</span>
          {badge}
          {titleAside != null && <><span className="clr-spacer" />{titleAside}</>}
        </div>
        {subtitle != null && <div className="clr-desc">{subtitle}</div>}
        {body != null && <div className="clr-body">{body}</div>}
      </div>
      {trailing != null && <div className="clr-aside">{trailing}</div>}
    </div>
  );
}
