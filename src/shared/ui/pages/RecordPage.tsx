// RecordPage — the Pages-tier composition for KEY-VALUE-shaped data (#2508, completing the #2505
// page-per-shape set): the complete record-detail page for ONE keyed record, built strictly from kit
// components. A titled IDENTITY header (PageHeader → Box + SectionHeader: title + optional status
// Chip beside it, subtitle in the hint slot, an actions slot), grouped KeyValueList sections — each a
// SectionLabel over the key-value archetype (#2475) — and an optional side column (facts, related
// items) in the #2505 detail-column idiom. Pure/presentational — the typed `sections` in via props
// are the whole data source; no selection machinery (the page renders one record).
import type { ReactNode } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import { Chip, type ChipTone } from "@/shared/ui/data/Chip";
import { KeyValueList, type KeyValueItem } from "@/shared/ui/data/KeyValueList";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { PageHeader } from "./pageHeader";

/** One labelled group of the record's fields — a SectionLabel over a KeyValueList. */
export interface RecordSection {
  label: string;
  /** The group's { k, v } rows, in display order. */
  entries: KeyValueItem[];
}

export interface RecordPageProps {
  /** The record's identity — the page title (the header bar). */
  title: ReactNode;
  /** Dimmed identity sub-text after the title (the header hint slot). */
  subtitle?: ReactNode;
  /** A status Chip label rendered beside the title (e.g. "running", "archived"). */
  status?: string;
  /** Status Chip tone. Default "neutral". */
  statusTone?: ChipTone;
  /** Right-aligned header actions (edit, open, delete). */
  actions?: ReactNode;
  /** The record's field groups, in display order. */
  sections: RecordSection[];
  /** Optional side column (facts, related items) beside the sections. */
  aside?: ReactNode;
  /** Side column width in px. Default 300. */
  asideWidth?: number;
  /** Extra class on the root (a page scoping hook). */
  className?: string;
}

export function RecordPage({
  title, subtitle, status, statusTone = "neutral", actions,
  sections, aside, asideWidth = 300, className,
}: RecordPageProps) {
  const heading = status != null ? (
    <Row gap={8} inline>
      {title}
      <Chip size="xs" tone={statusTone}>{status}</Chip>
    </Row>
  ) : title;

  return (
    <Stack gap={0} className={className} style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
      <PageHeader title={heading} hint={subtitle} toolbar={actions} />
      <Row gap={0} align="stretch" style={{ flex: 1, minHeight: 0 }}>
        <Box pad={16} style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
          {sections.length > 0 ? (
            <Stack gap={20}>
              {sections.map((s) => (
                <Stack key={s.label} gap={10}>
                  <SectionLabel>{s.label}</SectionLabel>
                  <KeyValueList items={s.entries} />
                </Stack>
              ))}
            </Stack>
          ) : (
            <EmptyState iconVariant="dashed" icon="▤" size="sm" title="No fields yet"
              description="Sections appear here as the record's fields fill in." />
          )}
        </Box>
        {aside != null && (
          <Box pad={16} style={{ width: asideWidth, flex: "none", minWidth: 0, overflowY: "auto", borderLeft: "1px solid var(--border-soft)" }}>
            {aside}
          </Box>
        )}
      </Row>
    </Stack>
  );
}
