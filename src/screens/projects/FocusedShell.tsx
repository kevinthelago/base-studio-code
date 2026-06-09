// Focused planner pane (#652) — the presentational shell around a single phase: the
// navigable stepper, the phase header with gate pill, lock/done banners, and the footer
// advance bar. Pure presentational (props in, callbacks out); the phase model + footer
// logic live in focusedPlan.ts. Styling: projectPane.css, scoped under .fp.
import { Fragment } from "react";
import type { Phase, GatePill, FooterKind } from "./focusedPlan";

/** The navigable phase stepper. `highlight` pulses the nodes the user still has to
 *  finish (the locked-Triage feedback, #652). */
export function Stepper({ phases, selectedIdx, onSelect, highlight }: {
  phases: Phase[]; selectedIdx: number; onSelect: (i: number) => void; highlight?: Set<string>;
}) {
  return (
    <div className="stepper">
      <div className="stepper-track">
        {phases.map((p, i) => (
          <Fragment key={p.key}>
            <button
              type="button"
              className={`step ${p.status}${i === selectedIdx ? " selected" : ""}${highlight?.has(p.key) ? " attn" : ""}`}
              onClick={() => onSelect(i)}
              title={p.name}
            >
              <span className="step-node">
                {p.status === "complete" ? "✓" : p.status === "locked" ? <span style={{ fontSize: 9 }}>🔒</span> : i + 1}
                {p.status === "active" && <span className="live-ring" />}
              </span>
              <span className="step-label">{p.name}</span>
            </button>
            {i < phases.length - 1 && <span className={"step-conn" + (p.status === "complete" ? " fill" : "")} />}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** Eyebrow + title + blurb + gate pill for the focused phase. */
export function PhaseHeader({ phase, pill }: { phase: Phase; pill: GatePill }) {
  return (
    <div className="ph-head">
      <div className="ph-eyebrow">
        <span className="num">PHASE {String(phase.index + 1).padStart(2, "0")} / {String(phase.total).padStart(2, "0")}</span>
        <span>·</span><span>{phase.key}</span>
      </div>
      <div className="ph-title"><h2>{phase.name}</h2></div>
      <p className="ph-blurb">{phase.blurb}</p>
      <span className={"ph-gate " + (pill === "blocked" ? "fail" : pill)}>
        <span className="gd" />
        gate · {phase.gate} — {pill === "pass" ? "passing" : pill === "blocked" ? "blocked" : "waiting"}
      </span>
    </div>
  );
}

/** Shown when browsing a not-yet-reachable phase. */
export function LockBanner({ activeName }: { activeName: string }) {
  return (
    <div className="lock-banner">
      🔒 <span><b>Locked.</b> Complete <b>{activeName}</b> to unlock this phase. Previewing only.</span>
    </div>
  );
}

/** Shown when reviewing a completed phase. */
export function DoneBanner() {
  return (
    <div className="lock-banner" style={{ background: "color-mix(in oklch,var(--success),transparent 91%)", borderColor: "color-mix(in oklch,var(--success),transparent 72%)" }}>
      ✓ <span style={{ color: "var(--fg-muted)" }}><b style={{ color: "var(--success)" }}>Completed.</b> Edits here re-open the phase for review.</span>
    </div>
  );
}

const FOOTER_LABEL: Record<FooterKind, string> = {
  "back-to-current": "↩ back to current",
  "jump-to-current": "jump to current →",
  "approve-continue": "approve & continue →",
  "publish": "⎇ Publish to GitHub",
};

/** The advance bar: back · progress · the context-sensitive primary action. */
export function PhaseFooter({ phase, action, onBack, onPrimary }: {
  phase: Phase;
  action: { kind: FooterKind; enabled: boolean };
  onBack: () => void;
  onPrimary: () => void;
}) {
  const primaryLabel = action.kind === "approve-continue" && !action.enabled ? "gate blocking…" : FOOTER_LABEL[action.kind];
  const primary = action.kind === "approve-continue" || action.kind === "publish";
  return (
    <div className="ph-foot">
      <button className="nav-btn" disabled={phase.index === 0} onClick={onBack}>← back</button>
      <span className="prog">phase {phase.index + 1} of {phase.total}</span>
      <span style={{ flex: 1 }} />
      <button className={"nav-btn" + (primary ? " primary" : "")} disabled={!action.enabled} onClick={onPrimary}>
        {primaryLabel}
      </button>
    </div>
  );
}
