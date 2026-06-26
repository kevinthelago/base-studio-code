// useModalDismiss (#1541) — the Escape-to-close + overlay-click-to-close pattern that was
// hand-rolled inline across the app's modals (`Dialog.tsx` is the reference implementation).
//
//  - useModalDismiss(onClose, { enabled }) — a window keydown Escape listener → onClose, with
//    cleanup on unmount / deps-change. `enabled` (default true) gates it, e.g. `{ enabled: !busy }`.
//  - overlayDismiss(onClose?) — an onMouseDown/onClick handler that fires onClose ONLY when the
//    event hits the overlay itself (`e.target === e.currentTarget`), so clicks on the inner card
//    don't dismiss. Pass `undefined` (e.g. while busy/deleting) to disable dismissal entirely.

import { useEffect, type MouseEvent } from "react";

export function useModalDismiss(onClose: () => void, opts?: { enabled?: boolean }): void {
  const enabled = opts?.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, enabled]);
}

/** An overlay click/mousedown handler that dismisses only when the overlay itself is the target.
 *  `onClose === undefined` makes it a no-op (use for a busy/locked modal). */
export function overlayDismiss(onClose?: () => void) {
  return (e: MouseEvent) => {
    if (onClose && e.target === e.currentTarget) onClose();
  };
}
