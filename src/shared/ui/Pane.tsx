// Pane (#1824) — the ONE detail/editor pane. A single header / scrollable-body / footer frame
// shared by every "select an item → edit its fields" surface. Two modes:
//   - mode="drawer": a slide-over (scrim + slide-in) — replaces the per-feature DrawerSlideOver +
//     the hand-rolled SkillDrawer chrome. Renders content only while `open`.
//   - mode="inline": the same frame filling its container — for master-detail editors (Automations,
//     the planner pane).
// The footer is either supplied (`footer` slot) or, in drawer mode, the standard draft/remove bar
// every editor shares (cancel/done while drafting, remove/done for an existing item). Pairs with
// the `useDraft` hook for the selection/draft state.
import { type ReactNode } from "react";
import { IconButton } from "@/shared/ui/IconButton";
import "./pane.css";

export interface PaneProps {
  /** "drawer" = slide-over (scrim + slide-in); "inline" = fills its container. Default "drawer". */
  mode?: "drawer" | "inline";
  /** Drawer mode: drives the scrim/slide open state + gates body render. Default true (inline ignores it). */
  open?: boolean;
  /** Top-zone content (drawer mode auto-appends a close button after it). */
  header?: ReactNode;
  /** Body content — pass via `body` or as children. */
  body?: ReactNode;
  children?: ReactNode;
  /** Custom footer. When omitted in drawer mode, the standard draft/remove bar is rendered. */
  footer?: ReactNode;
  // ── Standard drawer footer wiring (used when `footer` is not supplied) ──
  onClose?: () => void;
  onRemove?: () => void;
  isDraft?: boolean;
  onCommit?: () => void;
  /** Disable the draft "done" button (e.g. a required field is empty). */
  commitDisabled?: boolean;
  /** Drop the body's default padding — for bodies whose sections supply their own (e.g. full-bleed
   *  divider rows). */
  flush?: boolean;
  /** Extra class on the frame element (the drawer aside / the inline section). */
  className?: string;
}

/** The standard drawer footer: cancel/done while drafting, remove/done for an existing item. */
function StandardFooter({ isDraft, onClose, onRemove, onCommit, commitDisabled }: PaneProps) {
  return isDraft ? (
    <>
      <button className="btn ghost" onClick={onClose}>cancel</button>
      <div className="spacer" />
      <button className="btn primary" disabled={commitDisabled} onClick={onCommit}>done</button>
    </>
  ) : (
    <>
      <button className="btn ghost danger" onClick={onRemove}>remove</button>
      <div className="spacer" />
      <button className="btn primary" onClick={onClose}>done</button>
    </>
  );
}

export function Pane(props: PaneProps) {
  const { mode = "drawer", open = true, header, body, children, footer, onClose, flush, className } = props;
  const content = body ?? children;
  const bodyClass = "pane-body" + (flush ? " flush" : "");
  const foot = footer !== undefined
    ? footer
    : mode === "drawer" ? <StandardFooter {...props} /> : null;

  if (mode === "inline") {
    return (
      <section className={className ? `pane-inline ${className}` : "pane-inline"}>
        {header != null && <div className="pane-head">{header}</div>}
        <div className={bodyClass}>{content}</div>
        {foot != null && <div className="pane-foot">{foot}</div>}
      </section>
    );
  }

  return (
    <>
      <div className={"pane-scrim" + (open ? " on" : "")} onClick={onClose} />
      <div className={"pane-drawer" + (open ? " on" : "") + (className ? " " + className : "")}>
        {open && (
          <>
            <div className="pane-head">
              {header}
              <IconButton aria-label="close" onClick={onClose} />
            </div>
            <div className={bodyClass}>{content}</div>
            {foot != null && <div className="pane-foot">{foot}</div>}
          </>
        )}
      </div>
    </>
  );
}
