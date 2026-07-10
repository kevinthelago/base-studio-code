// RailSection (#2797) — one collapsible section in a left rail: a RailGroupHeader (label · count ·
// disclosure caret) over its rows, hidden when collapsed. The shared building block that makes every
// graph rail group the same way (Algorithms by kind, Teams by department, …). Controlled — the caller
// owns the open state (see the `useRailSections` hook), so it survives re-renders + search filtering.
import type { ReactNode } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { RailGroupHeader } from "./RailGroupHeader";

export interface RailSectionProps {
  /** The section label (uppercase mono micro-label). */
  label: ReactNode;
  /** Optional right-aligned member count. */
  count?: ReactNode;
  /** Whether the section is expanded. */
  open: boolean;
  /** Toggle handler. */
  onToggle: () => void;
  /** Optional right-aligned action beside the count (e.g. Skills' "＋ New group"). Renders INSIDE the
   *  header toggle button, so it must stop propagation on click and be a non-`<button>` element. */
  action?: ReactNode;
  /** The section's rows (rendered only when `open`). */
  children: ReactNode;
}

/** A collapsible left-rail section. See {@link RailSectionProps}. */
export function RailSection({ label, count, open, onToggle, action, children }: RailSectionProps) {
  return (
    <Box style={{ marginBottom: 4 }}>
      <RailGroupHeader collapsible open={open} onToggle={onToggle} count={count} action={action}>{label}</RailGroupHeader>
      {open && <Box>{children}</Box>}
    </Box>
  );
}
