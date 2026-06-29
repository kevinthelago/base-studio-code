import type { ReactNode } from "react";
import { Toggle } from "@/shared/ui/controls/Toggle";

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

// The labelled-field helpers were promoted to shared/ui (#1891) — the `.field` stack (label · input ·
// hint) is generic, not settings-specific. Re-exported under their `Settings*` names so the existing
// call sites keep working; new code should import `TextField`/`SelectField` from `@/shared/ui/controls/Field`.
export { TextField as SettingsTextField, SelectField as SettingsSelectField } from "@/shared/ui/controls/Field";
