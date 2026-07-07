// KeyValueList — the read-only label : value property list (#2475). The key-value archetype of the
// row vocabulary (#1865 siblings: CardListRow for card lists, DataTableRow for columnar tables): one
// aligned two-column grid of `{ k, v }` rows — a detail summary, a config/property panel, an
// inspector's facts block. It exists because nothing else in the kit renders a keyed RECORD:
// StatTile is a single KPI pair, the Field controls are editable inputs, RoleTierChips is
// domain-fixed. Loading renders shimmer value placeholders in place (#2302/#2234).
import { Fragment, type ReactNode } from "react";
import { Skeleton } from "@/shared/ui/feedback/Skeleton";

/** One property row — a label (`k`) and its value (`v`). */
export interface KeyValueItem {
  k: ReactNode;
  v: ReactNode;
}

export interface KeyValueListProps {
  /** The { k, v } rows, in display order. */
  items: KeyValueItem[];
  /** Fixed label column width in px. */
  labelWidth?: number;
  /** Render values in the mono font (ids, paths, config values). */
  mono?: boolean;
  /** Render shimmer value placeholders (labels stay) while the record's source loads (#2302). */
  loading?: boolean;
  className?: string;
}

/** The label : value property list — a `labelWidth px · 1fr` grid, one row per item. */
export function KeyValueList({ items, labelWidth = 120, mono, loading, className }: KeyValueListProps) {
  return (
    <div
      className={className}
      style={{
        display: "grid",
        gridTemplateColumns: `${labelWidth}px 1fr`,
        rowGap: 7,
        columnGap: 12,
        alignItems: "baseline",
      }}
    >
      {items.map((it, i) => (
        <Fragment key={i}>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: ".05em",
              color: "var(--fg-muted)",
            }}
          >
            {it.k}
          </span>
          {loading ? (
            <Skeleton h={11} w="60%" radius={4} />
          ) : (
            <span style={{ fontSize: 12, color: "var(--fg)", ...(mono ? { fontFamily: "var(--mono)" } : {}) }}>
              {it.v}
            </span>
          )}
        </Fragment>
      ))}
    </div>
  );
}
