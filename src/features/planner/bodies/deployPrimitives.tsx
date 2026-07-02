// Shared presentational primitives for the Deploy stage body (#1636) — extracted verbatim from
// DeployView.tsx. These are the Deploy-pane-LOCAL form helpers (Card/Field/Seg/Toggle/Select) and
// inline style objects (prop/chip). Their signatures deliberately differ from the cross-body
// primitives in bodyPrimitives.tsx (e.g. this Card is numbered/done-aware) and so are NOT merged.

import { useState } from "react";
import { Toggle as Switch } from "@/shared/ui/controls/Toggle";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { MONO, grpLabel, monoSm } from "./bodyStyles";

export const prop: React.CSSProperties = { fontFamily: MONO, fontSize: 9, color: "var(--accent)" };
export const chip: React.CSSProperties = {
  padding: "1px 7px", borderRadius: 99, fontFamily: MONO, fontSize: 9, background: "var(--bg-elev2)",
  color: "var(--fg-muted)", border: "1px solid var(--border-soft)", whiteSpace: "nowrap",
};

/** A collapsible card with a numbered (or ✓-when-done) tile, title, optional accent + right slot.
 *  Collapsed by default (#1421 follow-up) — the whole header row is the toggle, mirroring the
 *  repo/source cards' chevron affordance; pass `defaultOpen` to start expanded (e.g. an untargeted
 *  Target card that still needs input). */
export function Card({ n, title, hint, right, accent, done, defaultOpen = false, children }: {
  n: string; title: string; hint?: string; right?: React.ReactNode; accent?: string; done?: boolean;
  defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const tileColor = done ? "var(--success)" : accent ?? "var(--fg-dim)";
  return (
    <div style={{
      borderRadius: "var(--r-lg)", padding: "13px 14px",
      border: "1px solid " + (done ? "color-mix(in oklch, var(--success), transparent 58%)" : accent ? `color-mix(in oklch, ${accent}, transparent 78%)` : "var(--border-soft)"),
      // Confirmed (done) cards read as outline-only — green border, no green background fill (#1498).
      background: "var(--bg-panel)",
    }}>
      <Row
        onClick={() => setOpen((o) => !o)}
        gap={9}
        style={{ marginBottom: open ? 12 : 0, cursor: "pointer", userSelect: "none" }}
      >
        <span style={{
          width: 20, height: 20, borderRadius: 6, flex: "0 0 20px", display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: MONO, fontSize: 9, color: tileColor,
          background: done ? "color-mix(in oklch, var(--success), transparent 80%)" : "var(--bg-elev)",
          border: "1px solid " + (done ? "var(--success)" : accent ? `color-mix(in oklch, ${accent}, transparent 65%)` : "var(--border-soft)"),
        }}>{done ? "✓" : n}</span>
        <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>{title}</span>
        {hint && <span style={monoSm}>{hint}</span>}
        <Spacer />
        {right}
        <span style={{ color: "var(--fg-dim)", fontFamily: MONO, fontSize: 11, width: 12, textAlign: "center" }}>{open ? "▾" : "▸"}</span>
      </Row>
      {open && children}
    </div>
  );
}

/** Group divider — "A · HOW IT SHIPS", colored rule. */
export function Divider({ label, color }: { label: string; color: string }) {
  return (
    <Row gap={10} style={{ marginTop: 2 }}>
      <span style={{ fontFamily: MONO, fontSize: 9.5, color, letterSpacing: ".1em", fontWeight: 600 }}>{label}</span>
      <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
    </Row>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", overflow: "hidden" }}>
      {options.map((o, i) => (
        <button key={o} onClick={() => onChange(o)} style={{
          height: 22, padding: "0 9px", border: 0, borderLeft: i ? "1px solid var(--border-soft)" : "none", cursor: "pointer",
          fontFamily: MONO, fontSize: 9.5, background: value === o ? "var(--bg-elev2)" : "transparent", color: value === o ? "var(--fg)" : "var(--fg-dim)",
        }}>{o}</button>
      ))}
    </div>
  );
}

export function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
      <span style={grpLabel}>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} style={{
        height: 26, padding: "0 8px", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
        borderRadius: "var(--r-sm)", outline: "none", fontFamily: MONO, fontSize: 11, color: "var(--fg)",
      }} />
    </label>
  );
}

export function Toggle({ on, onClick, label, value }: { on: boolean; onClick: () => void; label: string; value?: string }) {
  return (
    <Row gap={9}>
      <Switch on={on} onClick={onClick} size="sm" tone="success" />
      <span style={{ fontFamily: MONO, fontSize: 10, color: on ? "var(--fg)" : "var(--fg-muted)", lineHeight: 1.3 }}>{label}</span>
      <Spacer />
      {value && <span style={{ fontFamily: MONO, fontSize: 9.5, color: on ? "var(--fg-muted)" : "var(--fg-dim)" }}>{value}</span>}
    </Row>
  );
}

/** A small native <select>, styled to match the card's fields (#1192). */
export function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T | ""; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
      <span style={grpLabel}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} style={{
        height: 28, padding: "0 8px", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
        borderRadius: "var(--r-sm)", outline: "none", fontFamily: MONO, fontSize: 11, color: "var(--fg)",
      }}>
        <option value="" disabled>—</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}
