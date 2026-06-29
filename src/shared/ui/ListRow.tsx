import type { ReactNode } from "react";
import "./listRow.css";

export interface ListRowProps {
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

/** ListRow — the ONE selectable list-item row: a `[lead · title+badge / subtitle · trailing]` grid.
 *  Every feature's row (mcp servers/hooks, skills, agent profiles/assignments, …) composes this with
 *  its own slot content, so there is one row shape the kit/SDK can emit rather than N bespoke rows. */
export function ListRow({ lead, title, badge, subtitle, trailing, selected, off, onClick, className }: ListRowProps) {
  return (
    <div
      className={"list-row" + (selected ? " selected" : "") + (off ? " off" : "") + (className ? ` ${className}` : "")}
      onClick={onClick}
    >
      <div className="lr-lead">{lead}</div>
      <div className="lr-main">
        <div className="lr-line1">
          <span className="lr-name">{title}</span>
          {badge}
        </div>
        {subtitle != null && <div className="lr-desc">{subtitle}</div>}
      </div>
      {trailing != null && <div className="lr-aside">{trailing}</div>}
    </div>
  );
}
