// Shared presentational primitives for the planner focused-pane bodies — the single home for the
// reusable, cross-body components (Card, Readiness, ModeChip, EntityChip, SourceHead, Kv). Used by
// the data-collection panes (Targets, Source legitimacy, Mapping, …) and renamed from
// DataCollectionPrimitives.tsx in #1635 to reflect that it is the shared body-primitives module.
// Token-styled inline to match the other focused bodies (SourceBody etc.); transcribed from
// collection/panes.jsx.

import type { ReactNode } from "react";
import { type CollectMode, type CollectSource, modeHue } from "./dataCollection";
import { MONO as mono } from "./bodyStyles";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";

/** scrape / fetch pill. */
export function ModeChip({ mode }: { mode: CollectMode }) {
  const h = modeHue(mode);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 7px", borderRadius: 99,
      fontFamily: mono, fontSize: 9.5, whiteSpace: "nowrap",
      color: `oklch(0.78 0.11 ${h})`,
      background: `color-mix(in oklch, oklch(0.74 0.12 ${h}), transparent 88%)`,
      border: `1px solid color-mix(in oklch, oklch(0.74 0.12 ${h}), transparent 72%)`,
    }}>
      <span>{mode === "scrape" ? "🕸" : "⤓"}</span>{mode}
    </span>
  );
}

/** A Data Model entity name chip. */
export function EntityChip({ name }: { name: string }) {
  return (
    <span style={{
      padding: "1px 6px", borderRadius: 4, fontFamily: mono, fontSize: 9.5, color: "var(--fg-muted)",
      background: "var(--bg-elev2)", border: "1px solid var(--border-soft)",
    }}>{name}</span>
  );
}

/** A titled section card (the pane's building block). `accent` rings it in the accent hue. */
export function Card({ label, hint, badge, accent, children }: {
  label: string; hint?: string; badge?: ReactNode; accent?: boolean; children: ReactNode;
}) {
  return (
    <div style={{
      border: "1px solid " + (accent ? "color-mix(in oklch, var(--accent), transparent 72%)" : "var(--border-soft)"),
      borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)",
    }}>
      <Row gap={8} style={{ marginBottom: 9 }}>
        <span style={{ fontFamily: mono, fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--fg-dim)" }}>{label}</span>
        {badge}
        <Spacer />
        {hint && <span style={{ fontFamily: mono, fontSize: 9.5, color: "var(--fg-dim)" }}>{hint}</span>}
      </Row>
      {children}
    </div>
  );
}

/** A compact list-item card (mono title row + optional meta line) for the stage bodies' simple
 *  lists (skills, automations). `badge` sits inline after the title; `highlight` rings it in the
 *  accent hue (e.g. a freshly-authored skill). */
export function ListItemCard({ title, meta, badge, highlight }: {
  title: ReactNode; meta?: ReactNode; badge?: ReactNode; highlight?: boolean;
}) {
  return (
    <div style={{
      padding: "8px 10px", borderRadius: 6,
      background: highlight ? "var(--accent-soft)" : "var(--bg-canvas)",
      border: highlight ? "1px solid var(--accent)" : "1px solid var(--border-soft)",
    }}>
      <Row gap={6}>
        <div style={{ fontFamily: mono, fontSize: 11, color: "var(--fg)" }}>{title}</div>
        {badge}
      </Row>
      {meta != null && <div style={{ fontFamily: mono, fontSize: 9.5, color: "var(--fg-dim)", marginTop: 3 }}>{meta}</div>}
    </div>
  );
}

/** Source row header: mode chip · label · location. */
export function SourceHead({ s, right }: { s: CollectSource; right?: ReactNode }) {
  return (
    <Row gap={8}>
      <ModeChip mode={s.mode} />
      <span style={{ fontFamily: "var(--sans)", fontSize: 12.5, fontWeight: 600, color: "var(--fg)" }}>{s.label}</span>
      {s.loc && <span style={{ fontFamily: mono, fontSize: 9.5, color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.loc}</span>}
      <Spacer />
      {right}
    </Row>
  );
}

export interface ReadyCheck { id: string; label: string; ok: boolean; block?: boolean; detail?: string }

/** The gate-readiness card: per-check ✓ / ✕ / ○ with a count and an optional tail note. */
export function Readiness({ checks, tail }: { checks: ReadyCheck[]; tail?: ReactNode }) {
  const ok = checks.filter((c) => c.ok).length;
  return (
    <Card label="readiness" accent hint={ok === checks.length ? "gate met" : `${ok}/${checks.length}`}>
      <Stack gap={5}>
        {checks.map((c) => {
          const color = c.ok ? "var(--success)" : c.block ? "var(--danger)" : "var(--fg-dim)";
          return (
            <Row key={c.id} gap={8} style={{ fontFamily: mono, fontSize: 11 }}>
              <span style={{ color, width: 12 }}>{c.ok ? "✓" : c.block ? "✕" : "○"}</span>
              <span style={{ color: "var(--fg-muted)" }}>{c.label}</span>
              <Spacer />
              {c.detail && <span style={{ fontSize: 9.5, color: c.block ? "var(--danger)" : "var(--fg-dim)" }}>{c.detail}</span>}
            </Row>
          );
        })}
      </Stack>
      {tail && <div style={{ marginTop: 9, paddingTop: 9, borderTop: "1px solid var(--border-soft)", fontFamily: mono, fontSize: 10, color: "var(--fg-dim)", lineHeight: 1.5 }}>{tail}</div>}
    </Card>
  );
}

/** key→value cell used in the scope grid. */
export function Kv({ k, v }: { k: string; v?: string }) {
  return (
    <Stack gap={2}>
      <span style={{ fontFamily: mono, fontSize: 8.5, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--fg-dim)" }}>{k}</span>
      <span style={{ fontFamily: mono, fontSize: 10.5, color: "var(--fg-muted)" }}>{v || "—"}</span>
    </Stack>
  );
}
