// Focused planner pane (#652) — the presentational shell around a single phase: the
// navigable stepper, the phase header with gate pill, lock/done banners, and the footer
// advance bar. Pure presentational (props in, callbacks out); the phase model + footer
// logic live in focusedPlan.ts. Styling: projectPane.css, scoped under .fp.
import { Fragment, useState } from "react";
import { connectorKind, type Phase, type GatePill, type FooterKind } from "../stages/focusedPlan";
import type { StagePrompt } from "../session/plannerConductor";

/** The per-stage prompt helper (#…): the "?" affordance in the focused-pane header. The app no
 *  longer auto-injects prompts; instead this lists every injectable prompt for the stage and the
 *  user picks one to send into the planner chat. Renders nothing when the stage has no prompts. */
export function StagePromptHelp({ prompts, onInject }: {
  prompts: StagePrompt[];
  onInject: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (prompts.length === 0) return null;
  return (
    <>
      <button
        title="Inject a prompt for this stage"
        aria-label="Stage prompt helper"
        onClick={() => setOpen((o) => !o)}
        style={{
          position: "absolute", top: 12, right: 14, zIndex: 42,
          width: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center",
          borderRadius: 999, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 14, fontWeight: 700,
          background: open ? "color-mix(in oklch, var(--accent), transparent 84%)" : "var(--bg-elev)",
          border: `1px solid ${open ? "var(--accent)" : "var(--border)"}`,
          color: open ? "var(--accent)" : "var(--fg-muted)",
        }}
      >?</button>
      {open && (
        <>
          {/* click-away catcher */}
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 41 }} />
          <div role="menu" style={{
            position: "absolute", top: 44, right: 14, zIndex: 42, width: 360, maxHeight: 380, overflowY: "auto",
            background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)",
            boxShadow: "0 16px 48px rgba(0,0,0,.5)", padding: 6,
          }}>
            <div style={{
              padding: "6px 8px 8px", fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".06em",
              textTransform: "uppercase", color: "var(--fg-dim)",
            }}>Inject a prompt for this stage</div>
            {prompts.map((p, i) => (
              <button
                key={i}
                onClick={() => { onInject(p.text); setOpen(false); }}
                title="Inject into the planner chat"
                style={{
                  display: "block", width: "100%", textAlign: "left", cursor: "pointer",
                  background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)",
                  padding: "8px 10px", marginBottom: 5, color: "var(--fg)",
                }}
              >
                <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, fontWeight: 600, marginBottom: 3 }}>{p.label}</div>
                <div style={{
                  fontSize: 10.5, lineHeight: 1.5, color: "var(--fg-muted)",
                  display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden",
                }}>{p.text}</div>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** Format one unmet requirement: "resolve the discovery topics (3 of 5)". */
function reasonText(u: { label: string; detail?: string }): string {
  return u.detail ? `${u.label} (${u.detail})` : u.label;
}

/** The node glyph: ✓ for done (in-sequence or banked-ahead), ↷ for a skipped optional
 *  stage, ◆ for the current one, a number while pending. */
function nodeGlyph(p: Phase, i: number): string {
  if (p.status === "complete" || p.status === "ahead") return "✓";
  if (p.status === "active") return "◆";
  if (p.status === "skipped") return "↷";
  return String(i + 1);
}

/**
 * The sequenced rail (#668): one node per phase joined by connectors. Solid connectors
 * trace the in-sequence path walked so far; the current node pulses (accent ring); a
 * banked-ahead node (gate met out of sequence) is green-ringed, reached by a dashed
 * connector. Each node's glyph (◆ current · ↷ skipped · ✓ done) carries its state.
 * `highlight` pulses phases the user still has to finish.
 */
export function Stepper({ phases, selectedIdx, onSelect, highlight }: {
  phases: Phase[]; selectedIdx: number; onSelect: (i: number) => void; highlight?: Set<string>;
}) {
  return (
    <div className="seqrail-wrap">
      <div className="seqrail">
        {phases.map((p, i) => (
          <Fragment key={p.key}>
            <button
              type="button"
              className={`seqrail-seg ${p.status}${i === selectedIdx ? " sel" : ""}${highlight?.has(p.key) ? " attn" : ""}`}
              onClick={() => onSelect(i)}
              title={p.name}
            >
              <span className="seqrail-node">{nodeGlyph(p, i)}</span>
              <span className="seqrail-label">{p.name}</span>
            </button>
            {i < phases.length - 1 && <span className={"seqrail-conn " + connectorKind(phases, i)} />}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** Eyebrow + title + blurb + gate pill for the focused phase. The pill surfaces WHY the
 *  gate isn't met (#805): a hover tooltip + a click-to-toggle popover of what's still needed. */
export function PhaseHeader({ phase, pill, promptHelp }: {
  phase: Phase;
  pill: GatePill;
  /** Injectable prompts for this stage + the inject handler — drives the "?" helper (#…). */
  promptHelp?: { prompts: StagePrompt[]; onInject: (text: string) => void };
}) {
  const [showReasons, setShowReasons] = useState(false);
  const unmet = phase.unmet ?? [];
  // Only offer reasons while the gate isn't passing and there's something to explain.
  const hasReasons = pill !== "pass" && unmet.length > 0;
  const tip = hasReasons ? "Still needed: " + unmet.map(reasonText).join("; ") : undefined;
  return (
    <div className="ph-head" style={{ position: "relative" }}>
      {promptHelp && <StagePromptHelp prompts={promptHelp.prompts} onInject={promptHelp.onInject} />}
      <div className="ph-title">
        <h2>{phase.name}</h2>
        <span
          className={"ph-gate " + pill}
          title={tip}
          onClick={hasReasons ? () => setShowReasons((v) => !v) : undefined}
          style={{ cursor: hasReasons ? "pointer" : undefined }}
        >
          <span className="gd" />
          gate
          {hasReasons && <span style={{ marginLeft: 6, opacity: 0.75, textDecoration: "underline" }}>why?</span>}
        </span>
      </div>
      <p className="ph-blurb">{phase.blurb}</p>
      {hasReasons && showReasons && (
        <div role="status" style={{
          marginTop: 8, padding: "8px 11px", borderRadius: 7, maxWidth: 420,
          background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
          fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.6, color: "var(--fg-muted)",
        }}>
          <div style={{ color: "var(--fg-dim)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>
            Still needed to pass this gate
          </div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {unmet.map((u, i) => (
              <li key={i}>{u.label}{u.detail && <span style={{ color: "var(--fg-dim)" }}> — {u.detail}</span>}</li>
            ))}
          </ul>
        </div>
      )}
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
export function PhaseFooter({ phase, action, published, publishLabel, onBack, onPrimary, onSkip }: {
  phase: Phase;
  action: { kind: FooterKind; enabled: boolean; canSkip?: boolean };
  /** The project already has a GitHub board — the publish action re-syncs it ("Update GitHub", #823). */
  published?: boolean;
  /** Override the publish action's label (#923) — e.g. "Publish blueprint" for an authoring project,
   *  whose deliverable is a gist, not a GitHub board. */
  publishLabel?: string;
  onBack: () => void;
  onPrimary: () => void;
  /** Skip the active OPTIONAL stage (#921) — rendered when `action.canSkip`. */
  onSkip?: () => void;
}) {
  const primaryLabel =
    action.kind === "approve-continue" && !action.enabled ? "gate blocking…"
    : action.kind === "publish" && published ? "⟳ Update GitHub"
    : action.kind === "publish" && publishLabel ? publishLabel
    : FOOTER_LABEL[action.kind];
  const primary = action.kind === "approve-continue" || action.kind === "publish";
  // When the gate is blocking the advance button, the tooltip says what's still needed (#805).
  const unmet = phase.unmet ?? [];
  const blockedTip = action.kind === "approve-continue" && !action.enabled && unmet.length > 0
    ? "Still needed: " + unmet.map(reasonText).join("; ")
    : undefined;
  return (
    <div className="ph-foot">
      <button className="nav-btn" disabled={phase.index === 0} onClick={onBack}>← back</button>
      <span className="prog">phase {phase.index + 1} of {phase.total}</span>
      <span style={{ flex: 1 }} />
      {/* This stage is OPTIONAL — the USER decides whether to do or skip it (#921). */}
      {action.canSkip && onSkip && (
        <button
          className="nav-btn"
          onClick={onSkip}
          title="This stage is optional — skip it and continue without completing its gate"
        >
          skip stage →
        </button>
      )}
      <button className={"nav-btn" + (primary ? " primary" : "")} disabled={!action.enabled} onClick={onPrimary} title={blockedTip}>
        {primaryLabel}
      </button>
    </div>
  );
}
