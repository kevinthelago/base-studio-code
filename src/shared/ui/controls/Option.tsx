// Option (#3500) — a `<select>` choice, as a primitive.
//
// `SelectField` deliberately takes its options as CHILDREN so callers keep full control over each
// label. In hand-written JSX that is a plain `<option>`; in a spec-authored (data-driven) UI there was
// no way to say it at all, because the node vocabulary can only name manifest primitives. The legacy
// `field` kind hid the gap behind its own `options: string[]`, which meant a select's options were the
// one part of the kit an agent could only author through a shape the renderer special-cased.
//
// This is the compositional answer: `SelectField` holds `Option` children, exactly as the component
// already works, and nothing has to special-case a select.

import type { ReactNode } from "react";

interface OptionProps {
  /** The submitted value. Defaults to the visible text when omitted — the common case where they match. */
  value?: string;
  /** Unselectable in the list (typically a "Choose…" placeholder). */
  disabled?: boolean;
  /** The visible label. */
  children?: ReactNode;
}

export function Option({ value, disabled, children }: OptionProps) {
  return (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  );
}
