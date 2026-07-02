// CollapsibleCard — a generic framed, collapsible section card for the focused planner bodies
// (#…). The whole header row toggles (chevron affordance, mirroring the deploy `Card` and the
// repo/stream rows); collapsed by default so a pane of these reads as a tidy stack of headers the
// user opens on demand. Unlike the numbered deploy `Card` (deployPrimitives), this takes a plain
// icon + title, so it fits any section (coordination, shared deps, …).
import { useState } from "react";
import { MONO } from "./bodyStyles";
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
    <div style={{
      borderRadius: "var(--r-lg)", padding: "13px 14px", background: "var(--bg-panel)",
      border: "1px solid " + (tone ? `color-mix(in oklch, ${tone}, transparent 78%)` : "var(--border-soft)"),
    }}>
      <Row
        onClick={() => setOpen((o) => !o)}
        gap={9}
        style={{ marginBottom: open ? 12 : 0, cursor: "pointer", userSelect: "none" }}
      >
        {icon && (
          <span style={{
            width: 20, height: 20, borderRadius: 6, flex: "0 0 20px", display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: MONO, fontSize: 11, color: tone ?? "var(--fg-dim)",
            background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
          }}>{icon}</span>
        )}
        <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>{title}</span>
        {hint && <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-dim)" }}>{hint}</span>}
        <Spacer />
        {right}
        <span style={{ color: "var(--fg-dim)", fontFamily: MONO, fontSize: 11, width: 12, textAlign: "center" }}>{open ? "▾" : "▸"}</span>
      </Row>
      {open && children}
    </div>
  );
}
