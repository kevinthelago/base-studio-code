// TablePage — the Pages-tier composition for TABLE-shaped data (#2505, tier above the Layouts
// templates #2197): a complete records-browser page built strictly from kit components. A titled
// header bar (PageHeader → Box + SectionHeader), a columnar data table (DataTableHeader +
// DataTableRow — the table archetype, #1865), and a selected-record DETAIL panel (KeyValueList —
// the record rendering, #2475) in a SplitView inspector. Everything renders from the typed
// `columns` × `rows` inputs — pure/presentational, data in via props only.
//
// Selection follows the house idiom (Tree/Sequence): controlled when `selectedId` is present
// (may be null = none), else internal state seeded by `defaultSelectedId`.
import type { CSSProperties, ReactNode } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { DataTableHeader, DataTableRow } from "@/shared/ui/data/DataTableRow";
import { KeyValueList } from "@/shared/ui/data/KeyValueList";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { SplitView } from "@/shared/ui/layouts/SplitView";
import { PageHeader } from "./pageHeader";
import { usePageSelection } from "./useSelection";

/** One table column — `key` addresses each row's `cells`, `label` heads it. */
export interface TablePageColumn {
  key: string;
  label: string;
  /** The column's grid track (e.g. "80px", "2fr"). Default "1fr". */
  width?: string;
}

/** One record — cells keyed by column key. */
export interface TablePageRow {
  id: string;
  cells: Record<string, ReactNode>;
}

export interface TablePageProps {
  /** Page title (the header bar). */
  title: ReactNode;
  /** Dimmed hint after the title. */
  hint?: ReactNode;
  /** Right-aligned header controls (search, filters, actions). */
  toolbar?: ReactNode;
  /** The column set — order is display order; `key` addresses the row cells. */
  columns: TablePageColumn[];
  /** The records, in display order. */
  rows: TablePageRow[];
  /** Controlled selection — the selected row id (pair with onSelect); may be null. Omit for uncontrolled. */
  selectedId?: string | null;
  /** Uncontrolled: the initially selected row id. */
  defaultSelectedId?: string;
  /** Fires with the clicked row's id (both selection modes). */
  onSelect?: (id: string) => void;
  /** Detail panel override — a render fn of the selected row. Default: a KeyValueList of the
   *  row's cells under the first cell as a heading. */
  detail?: (row: TablePageRow) => ReactNode;
  /** Detail (SplitView secondary) width in px. Default 320. */
  detailWidth?: number;
  /** Extra class on the root (a page scoping hook). */
  className?: string;
}

const ELLIPSIS: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

export function TablePage({
  title, hint, toolbar,
  columns, rows,
  selectedId, defaultSelectedId, onSelect,
  detail, detailWidth = 320, className,
}: TablePageProps) {
  const { selected, select } = usePageSelection(selectedId, defaultSelectedId, onSelect);
  const template = columns.map((c) => c.width ?? "1fr").join(" ");
  const row = rows.find((r) => r.id === selected);

  return (
    <SplitView
      className={className}
      toolbar={<PageHeader title={title} hint={hint} toolbar={toolbar} meta={`${rows.length}`} />}
      secondarySize={detailWidth}
      primary={
        <Box pad={[12, 16]} style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "auto" }}>
          <DataTableHeader template={template}>
            {columns.map((c) => <Text key={c.key} as="span" style={ELLIPSIS}>{c.label}</Text>)}
          </DataTableHeader>
          {rows.map((r, i) => (
            <DataTableRow key={r.id} template={template} index={i}
              selected={selected === r.id} onClick={() => select(r.id)}>
              {columns.map((c) => <Box as="span" key={c.key} style={ELLIPSIS}>{r.cells[c.key]}</Box>)}
            </DataTableRow>
          ))}
          {rows.length === 0 && (
            <EmptyState iconVariant="dashed" icon="▦" size="sm" title="No records"
              description="Rows appear here as the collection fills." />
          )}
        </Box>
      }
      secondary={
        <Box pad={16} style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {row ? (
            detail?.(row) ?? (
              <Stack gap={12}>
                <Text size="md" weight={600}>{row.cells[columns[0]?.key ?? ""]}</Text>
                <KeyValueList items={columns.map((c) => ({ k: c.label, v: row.cells[c.key] }))} />
              </Stack>
            )
          ) : (
            <EmptyState iconVariant="dashed" icon="▦" size="sm" title="No record selected"
              description="Select a row to inspect its fields." />
          )}
        </Box>
      }
    />
  );
}
