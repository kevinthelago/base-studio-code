// CollectionPage — the Pages-tier composition for LIST-shaped data (#2505): the complete
// master→detail collection page built strictly from kit components. The MasterDetail template
// (#2198 — the list rail beside a detail column) under a titled header bar, with the rail rendered
// as CardListRow items (the card archetype of the row vocabulary, #1865 — lead dot, title, badge
// Chip, subtitle, trailing meta) and a selected-item DETAIL that renders the item's facts as a
// KeyValueList. Pure/presentational — the typed `items` collection in via props is the whole data
// source.
//
// Selection follows the house idiom: controlled via `selectedId` + `onSelect`, else uncontrolled.
import type { ReactNode } from "react";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Chip } from "@/shared/ui/data/Chip";
import { CardListRow } from "@/shared/ui/data/CardListRow";
import { KeyValueList, type KeyValueItem } from "@/shared/ui/data/KeyValueList";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { MasterDetail } from "@/shared/ui/layouts/MasterDetail";
import { PageHeader } from "./pageHeader";
import { usePageSelection } from "./useSelection";

/** One collection item — the rail row's slots plus the detail panel's facts. */
export interface CollectionItem {
  id: string;
  title: ReactNode;
  /** Secondary line under the title. */
  subtitle?: ReactNode;
  /** A small Chip label next to the title (e.g. a kind or status). */
  badge?: string;
  /** Badge Chip tone. Default "neutral". */
  badgeTone?: "neutral" | "accent" | "success" | "info" | "danger";
  /** Trailing dim meta on the row (a count, a time). */
  meta?: ReactNode;
  /** The item's facts — rendered as the detail panel's KeyValueList. */
  facts?: KeyValueItem[];
}

export interface CollectionPageProps {
  /** Page title (the header bar). */
  title: ReactNode;
  /** Dimmed hint after the title. */
  hint?: ReactNode;
  /** Right-aligned header controls (search, filters, actions). */
  toolbar?: ReactNode;
  /** The collection, in display order. */
  items: CollectionItem[];
  /** Controlled selection — the selected item id (pair with onSelect); may be null. Omit for uncontrolled. */
  selectedId?: string | null;
  /** Uncontrolled: the initially selected item id. */
  defaultSelectedId?: string;
  /** Fires with the clicked item's id (both selection modes). */
  onSelect?: (id: string) => void;
  /** Detail panel override — a render fn of the selected item. Default: title + subtitle + facts KeyValueList. */
  detail?: (item: CollectionItem) => ReactNode;
  /** Rail width in px. Default 280. */
  railWidth?: number;
  /** Extra class on the root (a page scoping hook). */
  className?: string;
}

export function CollectionPage({
  title, hint, toolbar,
  items,
  selectedId, defaultSelectedId, onSelect,
  detail, railWidth = 280, className,
}: CollectionPageProps) {
  const { selected, select } = usePageSelection(selectedId, defaultSelectedId, onSelect);
  const item = items.find((i) => i.id === selected);

  const defaultDetail = (it: CollectionItem): ReactNode => (
    <Stack gap={12}>
      <Text size="md" weight={600}>{it.title}</Text>
      {it.subtitle != null && <Text size="sm" tone="muted">{it.subtitle}</Text>}
      {it.facts && it.facts.length > 0 && <KeyValueList items={it.facts} />}
    </Stack>
  );

  return (
    <MasterDetail
      className={className}
      toolbar={<PageHeader title={title} hint={hint} toolbar={toolbar} meta={`${items.length}`} />}
      railWidth={railWidth}
      rail={
        items.length > 0 ? (
          <Stack gap={6}>
            {items.map((it) => (
              <CardListRow key={it.id}
                title={it.title}
                subtitle={it.subtitle}
                badge={it.badge != null ? <Chip size="xs" tone={it.badgeTone ?? "neutral"}>{it.badge}</Chip> : undefined}
                trailing={it.meta != null ? <Text size="xs" tone="dim" mono>{it.meta}</Text> : undefined}
                selected={selected === it.id}
                onClick={() => select(it.id)}
              />
            ))}
          </Stack>
        ) : (
          <EmptyState iconVariant="dashed" icon="▥" size="sm" title="Nothing here yet"
            description="Items appear here as the collection fills." />
        )
      }
      detail={
        item ? (detail?.(item) ?? defaultDetail(item)) : (
          <EmptyState iconVariant="dashed" icon="▥" size="sm" title="No item selected"
            description="Select an item in the list to inspect it." />
        )
      }
    />
  );
}
