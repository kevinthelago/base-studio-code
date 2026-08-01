// Accessible-interaction helpers (#3775, epic #2725) — make a styled non-button element (a `Box`, a
// row/card `<div>`) operable by keyboard, atomically. The whole point is that keyboard operability
// ships WITH the click, never separately: `clickable(onClick)` returns role + focusability + Enter/Space
// activation bundled with the click handler, so an element can never end up clickable-but-not-keyboard.
//
// A raw `onClick` on a `<div>`/`<span>` still trips the jsx-a11y guardrail (#3773) — that's deliberate:
// new interactive containers must come through here (or use a real Button/IconButton primitive).

import type { AriaRole, KeyboardEvent, MouseEvent } from "react";

// Typed mouse-only to match the ordinary `onClick` handlers call sites already have (`(e: MouseEvent) =>
// void` or `() => void`); the keydown path casts, which is safe because activation handlers use the
// event only for `stopPropagation`/`preventDefault`, never mouse coordinates.
type Activate<T extends Element> = (e: MouseEvent<T>) => void;

/** An `onKeyDown` that fires `activate` on Enter/Space (preventing Space-scroll). Pair with a literal
 *  `role` + `tabIndex={0}` on an ALWAYS-interactive element (where a static role reads cleanly and
 *  other handlers — pointer capture, drag — sit alongside). For a CONDITIONALLY-interactive element,
 *  reach for [`clickable`] instead so the role/tabindex disappear when it's inert. */
export function onEnterOrSpace<T extends Element = HTMLElement>(activate: Activate<T>) {
  return (e: KeyboardEvent<T>) => {
    // MODIFIED presses are not activations (#4134). Without this, Shift+Enter (and Ctrl/Alt/Meta+Enter)
    // activated any focused `clickable()` element — every rail row, card and toggle built on this bundle —
    // and `preventDefault`ed a chord the user meant for something else. A real button behaves this way:
    // Shift+Enter on one does not click it.
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(e as unknown as MouseEvent<T>);
    }
  };
}

/** The interactive-attribute bundle for a conditionally-clickable styled element: spread it on, and the
 *  element is a keyboard-operable button when `onClick` is set and fully inert (no role/tabindex/handler)
 *  when it isn't. Bundling is what makes it correct — role, focusability, click, and key-activation are
 *  all present or all absent, never a click without its keyboard equivalent. `opts.role` overrides the
 *  default `"button"` (e.g. `"switch"`, `"checkbox"`); `opts.label` sets an accessible name. */
export function clickable<T extends Element = HTMLElement>(
  onClick: Activate<T> | undefined,
  opts?: { role?: AriaRole; label?: string },
) {
  if (!onClick) return {} as const;
  return {
    role: opts?.role ?? "button",
    tabIndex: 0,
    "aria-label": opts?.label,
    onClick,
    onKeyDown: onEnterOrSpace<T>(onClick),
  };
}
