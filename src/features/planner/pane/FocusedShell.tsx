// Focused planner pane (#652) — the presentational shell around a single stage: the
// navigable stepper, the stage header with gate pill, lock/done banners, and the footer
// advance bar. Pure presentational (props in, callbacks out); the stage model + footer
// logic live in focusedPlan.ts. Styling: projectPane.css, scoped under .fp.
import { useState } from "react";
import { BackButton } from "@/shared/ui/controls/BackButton";
import { connectorKind, type Stage, type GatePill, type FooterKind } from "../stages/focusedPlan";
import { stageKind } from "../blueprints/blueprintCatalog";
import { ProgressionRail, type RailNode } from "./ProgressionRail";
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
        className="mono"
        title="Inject a prompt for this stage"
        aria-label="Stage prompt helper"
        onClick={() => setOpen((o) => !o)}
        style={{
          position: "absolute", top: 12, right: 14, zIndex: 42,
          width: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center",
          borderRadius: 999, cursor: "pointer", fontSize: 14, fontWeight: 700,
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
            <div className="mono" style={{
              padding: "6px 8px 8px", fontSize: 9.5, letterSpacing: ".06em",
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
                <div className="mono" style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 3 }}>{p.label}</div>
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

/**
 * The sequenced rail (#668): one node per stage joined by connectors. Solid connectors trace the
 * in-sequence path walked so far; the current node pulses (accent ring); a banked-ahead node (gate
 * met out of sequence) is green-ringed, reached by a dashed connector. `highlight` pulses stages the
 * user still has to finish.
 *
 * A thin adapter over the shared {@link ProgressionRail} (#1869): it maps each {@link Stage} to a
 * rail node (the stage's status IS the rail status), labels it with the stage name, shows the stage
 * icon (✓ once done — the card look we standardized on), and hands the rail the focused-plan
 * {@link connectorKind} so the dashed banked / solid walked / dim upcoming connectors are preserved.
 */
export function Stepper({ stages, selectedIdx, onSelect, highlight }: {
  stages: Stage[]; selectedIdx: number; onSelect: (i: number) => void; highlight?: Set<string>;
}) {
  const nodes: RailNode[] = stages.map((p) => ({
    key: p.key,
    status: p.status,
    icon: stageKind(p.key).glyph,
    label: p.name,
    title: p.name,
  }));
  return (
    <ProgressionRail
      nodes={nodes}
      variant="stepper"
      selectedIdx={selectedIdx}
      onSelect={onSelect}
      highlight={highlight}
      connectorKind={(_, i) => connectorKind(stages, i)}
    />
  );
}

/** Eyebrow + title + blurb + gate pill for the focused stage. The pill surfaces WHY the
 *  gate isn't met (#805): a hover tooltip + a click-to-toggle popover of what's still needed. */
export function StageHeader({ stage, pill, promptHelp }: {
  stage: Stage;
  pill: GatePill;
  /** Injectable prompts for this stage + the inject handler — drives the "?" helper (#…). */
  promptHelp?: { prompts: StagePrompt[]; onInject: (text: string) => void };
}) {
  const [showReasons, setShowReasons] = useState(false);
  const unmet = stage.unmet ?? [];
  // Only offer reasons while the gate isn't passing and there's something to explain.
  const hasReasons = pill !== "pass" && unmet.length > 0;
  const tip = hasReasons ? "Still needed: " + unmet.map(reasonText).join("; ") : undefined;
  return (
    <div className="ph-head" style={{ position: "relative" }}>
      {promptHelp && <StagePromptHelp prompts={promptHelp.prompts} onInject={promptHelp.onInject} />}
      <div className="ph-title">
        <h2>{stage.name}</h2>
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
      <p className="ph-blurb">{stage.blurb}</p>
      {hasReasons && showReasons && (
        <div role="status" className="mono" style={{
          marginTop: 8, padding: "8px 11px", borderRadius: 7, maxWidth: 420,
          background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
          fontSize: 11, lineHeight: 1.6, color: "var(--fg-muted)",
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

/** Shown when browsing a not-yet-reachable stage. */
export function LockBanner({ activeName }: { activeName: string }) {
  return (
    <div className="lock-banner">
      🔒 <span><b>Locked.</b> Complete <b>{activeName}</b> to unlock this stage. Previewing only.</span>
    </div>
  );
}

/** Shown when reviewing a completed stage. */
export function DoneBanner() {
  return (
    <div className="lock-banner" style={{ background: "color-mix(in oklch,var(--success),transparent 91%)", borderColor: "color-mix(in oklch,var(--success),transparent 72%)" }}>
      ✓ <span style={{ color: "var(--fg-muted)" }}><b style={{ color: "var(--success)" }}>Completed.</b> Edits here re-open the stage for review.</span>
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
export function StageFooter({ stage, action, published, publishLabel, onBack, onPrimary, onSkip }: {
  stage: Stage;
  action: { kind: FooterKind; enabled: boolean; canSkip?: boolean; override?: boolean };
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
    action.override ? "⚠ override gate & continue →"
    : action.kind === "approve-continue" && !action.enabled ? "gate blocking…"
    : action.kind === "publish" && published ? "⟳ Update GitHub"
    : action.kind === "publish" && publishLabel ? publishLabel
    : FOOTER_LABEL[action.kind];
  const primary = action.kind === "approve-continue" || action.kind === "publish";
  // When the gate is blocking the advance button, the tooltip says what's still needed (#805).
  // In override mode (#1285) the button IS enabled, but the tooltip warns it bypasses the gate.
  const unmet = stage.unmet ?? [];
  const stillNeeded = unmet.length > 0 ? "Still needed: " + unmet.map(reasonText).join("; ") : "";
  const blockedTip = action.override
    ? ("Override: advance past this stage's gate without meeting it." + (stillNeeded ? " " + stillNeeded : ""))
    : action.kind === "approve-continue" && !action.enabled && stillNeeded ? stillNeeded
    : undefined;
  return (
    <div className="ph-foot">
      <BackButton variant="text" label="back" className="nav-btn" disabled={stage.index === 0} onClick={onBack} aria-label="Back" />
      <span className="prog">stage {stage.index + 1} of {stage.total}</span>
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
      <button
        className={"nav-btn" + (primary ? " primary" : "")}
        disabled={!action.enabled}
        onClick={onPrimary}
        title={blockedTip}
        style={action.override ? { background: "var(--danger)", borderColor: "var(--danger)", color: "#1a120a" } : undefined}
      >
        {primaryLabel}
      </button>
    </div>
  );
}
