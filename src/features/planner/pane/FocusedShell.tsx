// Focused planner pane (#652) — the presentational shell around a single stage: the
// navigable stepper, the stage header with gate pill, lock/done banners, and the footer
// advance bar. Pure presentational (props in, callbacks out); the stage model + footer
// logic live in focusedPlan.ts. Styling: projectPane.css, scoped under .fp.
import { BackButton } from "@/shared/ui/controls/BackButton";
import { Button } from "@/shared/ui/controls/Button";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { connectorKind, type Stage, type GatePill, type FooterKind } from "../stages/focusedPlan";
import { stageKind } from "../blueprints/blueprintCatalog";
import { ProgressionRail, type RailNode } from "./ProgressionRail";
import type { StagePrompt } from "../session/plannerConductor";

/** Format one unmet requirement: "resolve the discovery topics (3 of 5)". */
function reasonText(u: { label: string; detail?: string }): string {
  return u.detail ? `${u.label} (${u.detail})` : u.label;
}

/**
 * The Stage Guidance card (#2862) — the always-visible panel that pairs the gate's REQUIREMENTS with
 * the suggested next-step PROMPT, replacing the easy-to-miss "?" helper and the click-to-reveal gate
 * "why?" popover. Shows the unmet requirements inline (`stage.unmet`) while the gate is blocking, and
 * the single current-step prompt (#2859) with a legible Inject button. Once the gate passes it
 * collapses to a "Gate ready" row. Renders nothing when there's neither a requirement nor a prompt.
 */
export function StageGuidanceCard({ stage, pill, prompt, onInject }: {
  stage: Stage;
  pill: GatePill;
  /** The current-step prompt for this stage (#2859) — absent when the stage has none. */
  prompt?: StagePrompt;
  onInject?: (text: string) => void;
}) {
  const unmet = stage.unmet ?? [];
  const showReqs = pill !== "pass" && unmet.length > 0;
  const showPrompt = !!prompt && !!onInject;
  if (!showReqs && !showPrompt) return null;
  const ready = pill === "pass";
  return (
    <Box className={"stage-guide " + pill} role="group" aria-label="Stage guidance">
      <Box className="sg-head">
        <Box as="span" className="sg-dot" />
        <Text as="span" className="sg-title">{ready ? "Gate ready" : "What’s still needed"}</Text>
      </Box>
      {showReqs && (
        <ul className="sg-reqs">
          {unmet.map((u, i) => (
            <li key={i}>{u.label}{u.detail && <Text as="span" tone="dim"> — {u.detail}</Text>}</li>
          ))}
        </ul>
      )}
      {showPrompt && (
        <Box className="sg-prompt">
          <Text as="div" className="sg-eyebrow">Suggested next step</Text>
          <Text as="div" className="sg-plabel">{prompt!.label}</Text>
          <Text as="div" className="sg-ptext">{prompt!.text}</Text>
          <Button variant="primary" size="sm" className="sg-inject" onClick={() => onInject!(prompt!.text)}>
            Inject →
          </Button>
        </Box>
      )}
    </Box>
  );
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

/** Eyebrow + title + blurb + a SLIM gate status pill for the focused stage. The pill is at-a-glance
 *  status only (pass/wait, with a hover tooltip of what's left, #805); the requirement DETAIL + the
 *  suggested prompt moved to the {@link StageGuidanceCard} (#2862). */
export function StageHeader({ stage, pill }: {
  stage: Stage;
  pill: GatePill;
}) {
  const unmet = stage.unmet ?? [];
  const tip = pill !== "pass" && unmet.length > 0 ? "Still needed: " + unmet.map(reasonText).join("; ") : undefined;
  return (
    <Box className="ph-head">
      <Box className="ph-title">
        <h2>{stage.name}</h2>
        <Box as="span" className={"ph-gate " + pill} title={tip}>
          <Box as="span" className="gd" />
          gate
        </Box>
      </Box>
      <p className="ph-blurb">{stage.blurb}</p>
    </Box>
  );
}

/** Shown when browsing a not-yet-reachable stage. */
export function LockBanner({ activeName }: { activeName: string }) {
  return (
    <Box className="lock-banner">
      🔒 <Box as="span"><b>Locked.</b> Complete <b>{activeName}</b> to unlock this stage. Previewing only.</Box>
    </Box>
  );
}

/** Shown when reviewing a completed stage. */
export function DoneBanner() {
  return (
    <Box className="lock-banner" bg="color-mix(in oklch,var(--success),transparent 91%)" style={{ borderColor: "color-mix(in oklch,var(--success),transparent 72%)" }}>
      ✓ <Text as="span" tone="muted"><b style={{ color: "var(--success)" }}>Completed.</b> Edits here re-open the stage for review.</Text>
    </Box>
  );
}

const FOOTER_LABEL: Record<FooterKind, string> = {
  "back-to-current": "↩ back to current",
  "jump-to-current": "jump to current →",
  "approve-continue": "approve & continue →",
  "route-design": "◈ route design to project →",
  "publish": "⎇ Publish to GitHub",
};

/** The advance bar: back · progress · the context-sensitive primary action. */
export function StageFooter({ stage, action, published, publishLabel, onBack, onPrimary, onSkip }: {
  stage: Stage;
  action: { kind: FooterKind; enabled: boolean; canSkip?: boolean; skipEnabled?: boolean };
  /** The project already has a GitHub board — the publish action re-syncs it ("Update GitHub", #823). */
  published?: boolean;
  /** Override the publish action's label (#923) — e.g. "Publish blueprint" for an authoring project,
   *  whose deliverable is a gist, not a GitHub board. */
  publishLabel?: string;
  onBack: () => void;
  onPrimary: () => void;
  /** Skip the active stage (#921/#2854) — rendered only when `action.skipEnabled` (the stage is
   *  skippable now, or gate-override is on). A required stage shows no Skip at all. */
  onSkip?: () => void;
}) {
  const primaryLabel =
    action.kind === "approve-continue" && !action.enabled ? "gate blocking…"
    : action.kind === "publish" && published ? "⟳ Update GitHub"
    : action.kind === "publish" && publishLabel ? publishLabel
    : FOOTER_LABEL[action.kind];
  const primary = action.kind === "approve-continue" || action.kind === "route-design" || action.kind === "publish";
  // When the gate is blocking the advance button, the tooltip says what's still needed (#805).
  const unmet = stage.unmet ?? [];
  const stillNeeded = unmet.length > 0 ? "Still needed: " + unmet.map(reasonText).join("; ") : "";
  const blockedTip =
    action.kind === "approve-continue" && !action.enabled && stillNeeded ? stillNeeded : undefined;
  // Skip tooltip (#2854): Skip only renders when actionable, so no "how to enable" case — an
  // intrinsically-skippable/optional stage is the ordinary skip; a stage skippable only because
  // gate-override is on warns it bypasses the gate.
  const skipTip = stage.skippable
    ? "This stage is skippable — skip it and continue without completing its gate."
    : "⚠ Gate override: skip past this required stage without meeting its gate.";
  return (
    <Box className="ph-foot">
      <BackButton variant="text" label="back" className="nav-btn" disabled={stage.index === 0} onClick={onBack} aria-label="Back" />
      <Box as="span" className="prog">stage {stage.index + 1} of {stage.total}</Box>
      <Box as="span" style={{ flex: 1 }} />
      {/* The Skip control renders only when the active stage is skippable now, or gate-override is on
          (#2854) — a required stage like Discovery shows none, not a disabled ghost. */}
      {action.skipEnabled && onSkip && (
        // eslint-disable-next-line no-restricted-syntax -- bespoke `.nav-btn` footer button (styled by the `.fp .nav-btn` CSS, not the .btn kit)
        <button
          className="nav-btn"
          onClick={onSkip}
          title={skipTip}
        >
          skip stage →
        </button>
      )}
      {/* eslint-disable-next-line no-restricted-syntax -- bespoke `.nav-btn` footer button (styled by the `.fp .nav-btn` CSS, not the .btn kit) */}
      <button
        className={"nav-btn" + (primary ? " primary" : "")}
        disabled={!action.enabled}
        onClick={onPrimary}
        title={blockedTip}
      >
        {primaryLabel}
      </button>
    </Box>
  );
}
