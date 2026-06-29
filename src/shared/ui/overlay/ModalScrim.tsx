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
import { type ReactNode, type CSSProperties } from "react";
import { useModalDismiss, overlayDismiss } from "@/shared/hooks/useModalDismiss";

export function ModalScrim({ children, onDismiss, align = "center", blur = false, className = "", style }: {
  children: ReactNode;
  onDismiss?: () => void;
  align?: "center" | "start";
  blur?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  useModalDismiss(() => onDismiss?.(), { enabled: !!onDismiss });
  const cls = ["modal-scrim", align === "start" ? "start" : "", blur ? "blur" : "", className].filter(Boolean).join(" ");
  return (
    <div className={cls} onMouseDown={overlayDismiss(onDismiss)} style={style}>
      {children}
    </div>
  );
}
