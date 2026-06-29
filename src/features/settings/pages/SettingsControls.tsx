import type { ReactNode } from "react";
import { Toggle } from "@/shared/ui/Toggle";

export function ToggleRow({ on, onToggle, title, children }: {
  on: boolean; onToggle: () => void; title: string; children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <Toggle on={on} onClick={onToggle} role="switch" ariaChecked={on} />
      <div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg)", marginBottom: 2 }}>
          {title}
        </div>
        <div className="hint">{children}</div>
      </div>
    </div>
  );
}


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

/** A labelled full-width text input (the `.field` stack: label · input · hint). `trailing` puts a
 *  control beside the input (e.g. a "Choose…" file-picker button). For full-width inputs where the
 *  horizontal SettingsRow layout doesn't fit. */
export function SettingsTextField({ label, hint, value, onChange, placeholder, type = "text", trailing }: {
  label: ReactNode; hint?: ReactNode; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; trailing?: ReactNode;
}) {
  const input = (
    <input className="input" type={type} value={value} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)} />
  );
  return (
    <div className="field">
      <label>{label}</label>
      {trailing ? <div style={{ display: "flex", gap: 8 }}>{input}{trailing}</div> : input}
      {hint != null && <div className="hint">{hint}</div>}
    </div>
  );
}

/** A labelled full-width <select> (the `.field` stack: label · select · hint). `children` are the
 *  <option>s, so callers keep full control over option labels. */
export function SettingsSelectField({ label, hint, value, onChange, children }: {
  label: ReactNode; hint?: ReactNode; value: string; onChange: (v: string) => void; children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>{children}</select>
      {hint != null && <div className="hint">{hint}</div>}
    </div>
  );
}
