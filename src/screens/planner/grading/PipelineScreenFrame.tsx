// PipelineScreenFrame — the shared chrome for a pipeline's "second screen" in the
// planning page. Every registered pipeline screen (render-preview today; generators
// later) composes this so they get consistent chrome and run-status for free and only
// supply their own body. Sections own the page; pipelines own their surface — this is
// the surface's frame.
//
// Layout: the fixed-width pane shell, a header (▸ label · badge · spacer · status ·
// actions · close), a body slot (`children`), and an optional footer slot.

import type { ReactNode } from "react";

export function PipelineScreenFrame({
  label, badge, statusLabel, statusColor, actions, onClose, footer, fullWidth, bare, children,
}: {
  /** The ▸ title, e.g. "preview". */
  label: string;
  /** A small badge after the label (e.g. the preview's 2d/3d mode tag). */
  badge?: ReactNode;
  /** Run-status text + color (right-aligned), typically derived from the pipeline run. */
  statusLabel?: string;
  statusColor?: string;
  /** Pipeline-specific header controls, rendered after the status, before close. */
  actions?: ReactNode;
  /** When provided, renders a dismiss affordance (stage-bound screens omit it). */
  onClose?: () => void;
  /** Pipeline-specific footer (e.g. the declared-screens approval list). */
  footer?: ReactNode;
  /** Fill the parent pane instead of the fixed 420px "second screen" width (e.g. the file
   *  intake surface, which is a full-width stage body). */
  fullWidth?: boolean;
  /** Hide the header bar entirely — for a bare, full-pane surface (e.g. the file-intake drop box). */
  bare?: boolean;
  /** The screen body. */
  children: ReactNode;
}) {
  return (
    <section style={{
      ...(fullWidth ? { flex: 1, minWidth: 0 } : { flex: "0 0 auto", width: 420, borderLeft: "1px solid var(--border-soft)" }),
      display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", background: "var(--bg-panel)",
    }}>
      {!bare && (
        <div style={{
          padding: "10px 14px", borderBottom: "1px solid var(--border-soft)",
          display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
        }}>
          <span style={{ color: "var(--accent)" }}>▸ {label}</span>
          {badge}
          <span style={{ flex: 1 }} />
          {statusLabel && <span style={{ fontSize: 10, color: statusColor ?? "var(--fg-dim)" }}>{statusLabel}</span>}
          {actions}
          {onClose && <button className="btn ghost sm" onClick={onClose} title="Close">✕</button>}
        </div>
      )}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {children}
      </div>

      {footer}
    </section>
  );
}
