import type { ReactNode, InputHTMLAttributes } from "react";
import { Skeleton } from "@/shared/ui/feedback/Skeleton";

/**
 * The shared form-field family (#1891) over the `.field` / `.input` CSS in `tokens.css` — the
 * `label · control · hint` vertical stack hand-rolled ~37× and (until now) only available as the
 * settings-scoped `SettingsTextField`/`SettingsSelectField`. Use these so non-settings code stops
 * re-writing `<div className="field"><label>…<input className="input"></div>`.
 */

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  /** A control rendered beside the input (e.g. a "Choose…" file-picker button). */
  trailing?: ReactNode;
  children: ReactNode;
}

/** The bare `label · control · hint` stack. Wrap any control (input, select, custom) as `children`. */
export function Field({ label, hint, trailing, children }: FieldProps) {
  return (
    <div className="field">
      {label != null && <label>{label}</label>}
      {trailing ? <div style={{ display: "flex", gap: 8 }}>{children}{trailing}</div> : children}
      {hint != null && <div className="hint">{hint}</div>}
    </div>
  );
}

export type TextFieldProps = {
  label?: ReactNode;
  hint?: ReactNode;
  trailing?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** Render LOADING (#2302): keep the label, replace the input with a skeleton the input's shape. */
  loading?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">;

/** A labelled `.input` text field (the `.field` stack). All native `<input>` attrs pass through. */
export function TextField({ label, hint, trailing, value, onChange, loading, className, ...rest }: TextFieldProps) {
  return (
    <Field label={label} hint={hint} trailing={trailing}>
      {loading ? (
        <Skeleton h={33} radius={7} />
      ) : (
        <input
          className={className ? `input ${className}` : "input"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...rest}
        />
      )}
    </Field>
  );
}

export interface SelectFieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** The `<option>`s — callers keep full control over the option labels. */
  children: ReactNode;
}

/** A labelled full-width `.input` `<select>` (the `.field` stack). */
export function SelectField({ label, hint, value, onChange, children }: SelectFieldProps) {
  return (
    <Field label={label} hint={hint}>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>{children}</select>
    </Field>
  );
}
