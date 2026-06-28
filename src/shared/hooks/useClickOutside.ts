import { useEffect, type RefObject } from "react";

/**
 * Dismiss a popover/menu on an outside `mousedown`. Listens only while `active`, and calls `onClose`
 * when the press lands outside `ref` (and outside `ignoreRef`, if given — use it for the toggle
 * button so its own click handler owns the open/close instead of double-firing). mousedown (not
 * click) so the menu doesn't unmount before an inner item's click fires. (Callers' inline `onClose`
 * is auto-memoized by react-compiler, so the listener isn't re-subscribed every render.)
 */
export function useClickOutside<E extends HTMLElement, I extends HTMLElement = HTMLElement>(
  ref: RefObject<E | null>,
  onClose: () => void,
  active: boolean,
  ignoreRef?: RefObject<I | null>,
): void {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ignoreRef?.current?.contains(t)) return;
      if (!ref.current?.contains(t)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [active, ref, ignoreRef, onClose]);
}
