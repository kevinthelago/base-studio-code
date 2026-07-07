// PageHeader — the Pages-tier internal header bar (#2505). Every page composition opens with the
// same full-width titled bar (title · hint · right-aligned controls), so it lives ONCE here and each
// page hands it to its layout template's `toolbar` slot. Deliberately UNREGISTERED (like
// DataTableHeader / ZoomControls): it's page plumbing, not a standalone kit primitive — the pages
// compose it out of the registered Box + SectionHeader.
import type { ReactNode } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { SectionHeader } from "@/shared/ui/layout/SectionHeader";

export interface PageHeaderProps {
  title: ReactNode;
  /** Dimmed inline sub-text after the title. */
  hint?: ReactNode;
  /** Right-aligned controls (search, filters, actions) — the page's `toolbar` slot content. */
  toolbar?: ReactNode;
  /** Right-aligned dim mono meta (e.g. a count) when there are no `toolbar` controls. */
  meta?: ReactNode;
}

/** The one page header bar: a bordered Box wrapping the canonical SectionHeader row. */
export function PageHeader({ title, hint, toolbar, meta }: PageHeaderProps) {
  return (
    <Box pad={[10, 16]} bg="var(--bg-elev)" style={{ flex: "none", borderBottom: "1px solid var(--border-soft)" }}>
      <SectionHeader title={title} hint={hint} right={toolbar} meta={meta} />
    </Box>
  );
}
