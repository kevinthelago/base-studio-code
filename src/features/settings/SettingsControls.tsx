// Shared settings UI primitives (#1745) — the card-header + row/select/button building blocks the
// settings tabs hand-rolled, in several cases byte-identically: `Row`/`Select` were duplicated in
// Performance.tsx + Logs.tsx, `btn()` in Logs.tsx + Storage.tsx, and the card-header block repeats
// across Appearance.tsx + General.tsx. One source so they can't drift.
import type { ReactNode, CSSProperties } from "react";

/** A settings-card header: a title, an optional inline hint, and an optional right-aligned control.
 *  The `.card` wrapper stays at the call site (it is a single class, not worth wrapping). */
export function SettingsCardHead({ title, hint, right }: { title: string; hint?: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {hint && <span className="hint">{hint}</span>}
      {right && <><span style={{ flex: 1 }} />{right}</>}
    </div>
  );
}

/** A settings row: label (+ optional hint) stacked on the left, a control on the right, divider beneath. */
export function SettingsRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-soft)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--fg)" }}>{label}</div>
        {hint && <div style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--fg-dim)", marginTop: 2 }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/** A compact mono <select> for a settings row; preserves the value's number/string type on change. */
export function SettingsSelect({ value, options, onChange }: {
  value: number | string;
  options: { label: string; value: number | string }[];
  onChange: (v: number | string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => { const raw = e.target.value; onChange(typeof value === "number" ? Number(raw) : raw); }}
      style={{ fontFamily: "var(--mono)", fontSize: 11.5, background: "var(--bg-elev)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 8px", cursor: "pointer" }}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Inline style for a compact mono settings button; `extra` overrides (e.g. an active border color). */
export function settingsBtn(extra: CSSProperties = {}): CSSProperties {
  return { padding: "5px 10px", borderRadius: 6, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10.5, background: "var(--bg-elev)", color: "var(--fg-muted)", border: "1px solid var(--border)", ...extra };
}
