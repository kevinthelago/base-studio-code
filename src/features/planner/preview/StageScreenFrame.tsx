// StageScreenFrame — the shared chrome for a stage module's "second screen" in the
// planning page. Every registered stage screen (render-preview today; generators
// later) composes this so they get consistent chrome and run-status for free and only
// supply their own body. Sections own the page; stage modules own their surface — this is
// the surface's frame.
//
// Layout: the fixed-width pane shell, a header (▸ label · badge · spacer · status ·
// actions · close), a body slot (`children`), and an optional footer slot.

import type { ReactNode } from "react";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

export function StageScreenFrame({
  label, badge, statusLabel, statusColor, actions, onClose, footer, fullWidth, bare, children,
}: {
  /** The ▸ title, e.g. "preview". */
  label: string;
  /** A small badge after the label (e.g. the preview's 2d/3d mode tag). */
  badge?: ReactNode;
  /** Run-status text + color (right-aligned), typically derived from the stage run. */
  statusLabel?: string;
  statusColor?: string;
  /** Stage-specific header controls, rendered after the status, before close. */
  actions?: ReactNode;
  /** When provided, renders a dismiss affordance (stage-bound screens omit it). */
  onClose?: () => void;
  /** Stage-specific footer (e.g. the declared-screens approval list). */
  footer?: ReactNode;
  /** Fill the parent pane instead of the fixed 420px "second screen" width (e.g. the file
   *  intake surface, which is a full-width stage body). */
  fullWidth?: boolean;
  /** Hide the header bar entirely — for a bare, full-pane surface (e.g. the file-intake drop box). */
  bare?: boolean;
  /** The screen body. */
  children: ReactNode;
}) {
  return (
    <section style={{
      ...(fullWidth ? { flex: 1, minWidth: 0 } : { flex: "0 0 auto", width: 420, borderLeft: "1px solid var(--border-soft)" }),
      display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", background: "var(--bg-panel)",
    }}>
      {!bare && (
        <Row className="mono" gap={8} style={{
          padding: "10px 14px", borderBottom: "1px solid var(--border-soft)",
          fontSize: 11, color: "var(--fg-muted)",
        }}>
          <Text as="span" tone="accent">▸ {label}</Text>
          {badge}
          <Box as="span" style={{ flex: 1 }} />
          {statusLabel && <Text as="span" size={10} style={{ color: statusColor ?? "var(--fg-dim)" }}>{statusLabel}</Text>}
          {actions}
          {onClose && <IconButton aria-label="Close" onClick={onClose} />}
        </Row>
      )}

      <Stack style={{ flex: 1, minHeight: 0 }}>
        {children}
      </Stack>

      {footer}
    </section>
  );
}
