import type { ReactNode } from "react";
import "./cardListRow.css";

export interface CardListRowProps {
  /** The 18px lead column — a status dot, icon, or avatar. */
  lead?: ReactNode;
  /** Primary label. */
  title: ReactNode;
  /** A pill rendered next to the title (e.g. a Tag). */
  badge?: ReactNode;
  /** Secondary line under the title. */
  subtitle?: ReactNode;
  /** The trailing (auto-width) column — chips, counts, controls, a toggle. */
  trailing?: ReactNode;
  /** Selection highlight. */
  selected?: boolean;
  /** Dimmed/disabled look. */
  off?: boolean;
  onClick?: () => void;
  className?: string;
}

/** CardListRow — the selectable card-list row: a `[lead · title+badge / subtitle · trailing]` bordered
 *  card. The card-list archetype of the row vocabulary (#1865); its sibling is <DataTableRow> for
 *  columnar tables. Every card-list (mcp servers/hooks, agent profiles, …) composes this with its own
 *  slot content, so the kit/SDK emits one row shape rather than N bespoke rows. */
export function CardListRow({ lead, title, badge, subtitle, trailing, selected, off, onClick, className }: CardListRowProps) {
  return (
    <div
      className={"card-list-row" + (selected ? " selected" : "") + (off ? " off" : "") + (className ? ` ${className}` : "")}
      onClick={onClick}
    >
      <div className="clr-lead">{lead}</div>
      <div className="clr-main">
        <div className="clr-line1">
          <span className="clr-name">{title}</span>
          {badge}
        </div>
        {subtitle != null && <div className="clr-desc">{subtitle}</div>}
      </div>
      {trailing != null && <div className="clr-aside">{trailing}</div>}
    </div>
  );
}
