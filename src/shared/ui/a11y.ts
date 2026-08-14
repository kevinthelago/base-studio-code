// Accessible-interaction helpers (#3775, epic #2725) — make a styled non-button element (a `Box`, a
// row/card `<div>`) operable by keyboard, atomically. The whole point is that keyboard operability
// ships WITH the click, never separately: `clickable(onClick)` returns role + focusability + Enter/Space
// activation bundled with the click handler, so an element can never end up clickable-but-not-keyboard.
//
// A raw `onClick` on a `<div>`/`<span>` still trips the jsx-a11y guardrail (#3773) — that's deliberate:
// new interactive containers must come through here (or use a real Button/IconButton primitive).

import { useEffect } from "react";
import type { AriaRole, KeyboardEvent, MouseEvent, RefObject } from "react";

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

// ── Modal focus management (#2725 Tier 0) ────────────────────────────────────────────────────────────

/** Elements that can hold focus, in DOM order. `:not([disabled])` and the negative-tabindex filter matter:
 *  a disabled button and a `tabIndex={-1}` container are both focusable-looking and both wrong to land on. */
const FOCUSABLE = [
  "a[href]", "button", "input", "select", "textarea",
  '[tabindex]:not([tabindex="-1"])',
].map((s) => `${s}:not([disabled]):not([aria-hidden="true"])`).join(",");

function focusableWithin(root: HTMLElement): HTMLElement[] {
  // Filtered on DECLARED hiddenness only — `hidden`, `aria-hidden`, `disabled` (in the selector above) —
  // never on layout.
  //
  // The textbook check is `offsetParent !== null`, and it is untestable here: jsdom has no layout, so
  // `offsetParent` is null for EVERY element and the filter silently returns an empty list. That is not a
  // hypothetical — it made all six focus tests fail on the first run, reporting "focus never moved" for a
  // trap that was working. The e2e harness cannot cover it either; it drives the preview srcdoc, not the
  // app shell.
  //
  // Little is lost: the browser already skips hidden elements during native Tab, and the trap only
  // intervenes at the two ends. A `display:none` element sitting exactly at an end would wrap to something
  // unfocusable — at which point the browser keeps focus where it is, which is still inside the modal.
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => !el.hidden && el.getAttribute("aria-hidden") !== "true");
}

/**
 * Trap focus inside `ref` while `enabled`, and put it back where it came from on close.
 *
 * A modal that does not do this is not "slightly less polished" — it is unusable with a screen reader.
 * Focus stays on the trigger BEHIND the overlay, so the reader never enters the dialog and never says one
 * opened; Tab then walks out into the page underneath, which is visually covered and obviously not
 * interactive to everyone except the person who cannot see it.
 *
 * Lives on `ModalScrim` rather than `Dialog` because 7 modal surfaces render through the scrim, including
 * the custom-bodied ones that supply their own card — fixing `Dialog` alone would miss them.
 *
 * Deliberately NOT tied to `onDismiss`: a non-dismissable modal (a destructive op in flight) is exactly
 * the one you must not be able to Tab out of.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    const root = ref.current;
    if (!enabled || !root) return;

    // Captured BEFORE we move focus, so close returns the user where they were rather than at the top of
    // the document. `body` is the fallback when focus was nowhere in particular.
    const restoreTo = document.activeElement as HTMLElement | null;

    const first = focusableWithin(root)[0];
    // Falls back to the container itself (it carries `tabIndex={-1}`) so a modal with no focusable content
    // — a spinner, a message — still moves the reader inside instead of leaving it behind the scrim.
    (first ?? root).focus();

    // `globalThis.KeyboardEvent`, NOT the React one this module already imports — a native listener gets
    // the DOM event, and the React synthetic type would typecheck while describing the wrong object.
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusableWithin(root);
      if (items.length === 0) {
        // Nothing to cycle between: hold focus on the container rather than letting Tab escape.
        e.preventDefault();
        root.focus();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      // Wrap at each end. The `!root.contains(active)` case catches focus that has already escaped (a
      // programmatic focus elsewhere) and pulls it back rather than letting Tab continue outward.
      if (e.shiftKey && (active === firstItem || !root.contains(active))) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && (active === lastItem || !root.contains(active))) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("keydown", onKeyDown);
      // Only restore if focus is still inside the closing modal. If something else has deliberately taken
      // focus (a toast, a newly opened second modal), stealing it back would be the bug.
      if (!root.contains(document.activeElement) && document.activeElement !== document.body) return;
      restoreTo?.focus?.();
    };
  }, [ref, enabled]);
}
