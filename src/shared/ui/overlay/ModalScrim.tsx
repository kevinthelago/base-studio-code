// ModalScrim (#1776) — the ONE centered-modal overlay. Fixed full-screen scrim (the `--scrim`
// token) at the `--z-modal` layer, flex-centering its child card, with Escape + overlay-click
// dismiss. Every modal/dialog renders its card inside this instead of hand-rolling a fixed overlay
// with a per-file scrim colour and z-index. `<Dialog>` is built on it; custom-bodied modals wrap
// their own card with it.
//
//  - onDismiss: called on Escape and on a click/mousedown that lands on the scrim itself (not the
//    card). Pass `undefined` to make the modal non-dismissable (e.g. while a destructive op is busy).
//  - align="start" top-aligns the card (for tall, scrolling modals); default centers it.
//  - blur adds the backdrop blur some modals used.
// FOCUS (#2725 Tier 0). The scrim owns focus management for every modal, because 7 surfaces render
// through it — including custom-bodied ones that supply their own card, which a fix on `<Dialog>`
// alone would miss. It takes focus on open, traps Tab inside, and restores focus on close; see
// `useFocusTrap`. Without it a screen reader never enters the dialog at all: focus stays on the
// trigger behind the overlay, and Tab walks out into the page underneath, which is covered.
//
// It does NOT carry `role="dialog"`. The scrim is the BACKDROP; the dialog is the card inside it, which
// is where `ModalCard` already put the role and where `<Dialog>` puts its own. Adding it here too made
// `getByRole("dialog")` ambiguous and, worse, nested one dialog inside another. Focus here, semantics on
// the card — that split is the reason a custom-bodied modal still gets trapped even though only its card
// can name itself.
import { useRef, type ReactNode, type CSSProperties } from "react";
import { useModalDismiss, overlayDismiss } from "@/shared/hooks/useModalDismiss";
import { useFocusTrap } from "@/shared/ui/a11y";

export function ModalScrim({ children, onDismiss, align = "center", blur = false, className = "", style }: {
  children: ReactNode;
  onDismiss?: () => void;
  align?: "center" | "start";
  blur?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalDismiss(() => onDismiss?.(), { enabled: !!onDismiss });
  // NOT gated on `onDismiss`. A non-dismissable modal — a destructive operation mid-flight — is exactly
  // the one the user must not be able to Tab out of.
  useFocusTrap(ref);
  const cls = ["modal-scrim", align === "start" ? "start" : "", blur ? "blur" : "", className].filter(Boolean).join(" ");
  return (
    // `tabIndex={-1}` makes the container itself a focus target, so a modal with no focusable content —
    // a spinner, a message — still moves the reader inside instead of leaving it behind the scrim.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- modal backdrop mouse-dismiss; keyboard dismiss is Escape via useModalDismiss
    <div
      ref={ref}
      className={cls}
      tabIndex={-1}
      onMouseDown={overlayDismiss(onDismiss)}
      style={style}
    >
      {children}
    </div>
  );
}
