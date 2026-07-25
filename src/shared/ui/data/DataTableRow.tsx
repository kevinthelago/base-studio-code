import type { ReactNode } from "react";
import { clickable } from "@/shared/ui/a11y";
import "./dataTable.css";

export interface DataTableHeaderProps {
  /** grid-template-columns — pass the SAME value as the rows so labels align over their columns. */
  template: string;
  /** The column-label cells. */
  children: ReactNode;
  className?: string;
}

/** DataTableHeader — the sticky column header for a <DataTableRow> table. */
export function DataTableHeader({ template, children, className }: DataTableHeaderProps) {
  return (
    <div className={"dt-header" + (className ? ` ${className}` : "")} style={{ gridTemplateColumns: template }}>
      {children}
    </div>
  );
}

export interface DataTableRowProps {
  /** grid-template-columns — shared with the <DataTableHeader> so cells align under their labels. */
  template: string;
  /** The cell content, one node per column. */
  children: ReactNode;
  /** Row index — when provided, odd rows get a zebra-stripe background. */
  index?: number;
  selected?: boolean;
  off?: boolean;
  onClick?: () => void;
  /** Fixed row height in px (default 37 via CSS). */
  height?: number;
  className?: string;
  /** Extra attributes spread onto the row element — e.g. `{ "data-skill-id": id }` for targeting. */
  attrs?: Record<string, string | number>;
}

/** DataTableRow — one columnar row of a data table: the columnar archetype of the row vocabulary
 *  (#1865; sibling: CardListRow). A shared `template` with the <DataTableHeader> aligns the columns;
 *  the row supplies zebra striping + hover + selection chrome. Cell content is the caller's, so any
 *  table (skills library, agent assignments, …) composes ONE row primitive rather than a bespoke one. */
export function DataTableRow({ template, children, index, selected, off, onClick, height, className, attrs }: DataTableRowProps) {
  return (
    <div
      className={
        "dt-row" +
        (selected ? " selected" : "") +
        (off ? " off" : "") +
        (index != null && index % 2 ? " odd" : "") +
        (className ? ` ${className}` : "")
      }
      style={{ gridTemplateColumns: template, ...(height != null ? { height: `${height}px` } : {}) }}
      {...clickable(onClick)}
      {...attrs}
    >
      {children}
    </div>
  );
}
