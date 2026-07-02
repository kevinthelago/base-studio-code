// CollapsibleCard — a generic framed, collapsible section card for the focused planner bodies
// (#…). The whole header row toggles (chevron affordance, mirroring the deploy `Card` and the
// repo/stream rows); collapsed by default so a pane of these reads as a tidy stack of headers the
// user opens on demand. Unlike the numbered deploy `Card` (deployPrimitives), this takes a plain
// icon + title, so it fits any section (coordination, shared deps, …).
import { useState } from "react";
import { MONO } from "./bodyStyles";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";

export function CollapsibleCard({ title, hint, icon, right, tone, defaultOpen = false, children }: {
  title: string;
  hint?: string;
  /** A small leading glyph (e.g. "◎"). */
  icon?: string;
  /** Right-aligned control/summary in the header row. */
  right?: React.ReactNode;
  /** Border accent color; defaults to the soft border. */
  tone?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Box radius="lg" bg="var(--bg-panel)" pad={[13, 14]} style={{
      border: "1px solid " + (tone ? `color-mix(in oklch, ${tone}, transparent 78%)` : "var(--border-soft)"),
    }}>
      <Row
        onClick={() => setOpen((o) => !o)}
        gap={9}
        style={{ marginBottom: open ? 12 : 0, cursor: "pointer", userSelect: "none" }}
      >
        {icon && (
          <Box as="span" radius={6} bg="var(--bg-elev)" border="soft" style={{
            width: 20, height: 20, flex: "0 0 20px", display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: MONO, fontSize: 11, color: tone ?? "var(--fg-dim)",
          }}>{icon}</Box>
        )}
        <Text as="span" size={13} weight={600} style={{ fontFamily: "var(--sans)", color: "var(--fg)" }}>{title}</Text>
        {hint && <Text as="span" mono size={9.5} tone="dim">{hint}</Text>}
        <Spacer />
        {right}
        <Text as="span" tone="dim" mono size={11} style={{ width: 12, textAlign: "center" }}>{open ? "▾" : "▸"}</Text>
      </Row>
      {open && children}
    </Box>
  );
}
