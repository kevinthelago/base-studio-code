// ProgressionRail (#1869) — the ONE horizontal status-rail behind both planner surfaces:
// the blueprint-card gate preview (`PlanGateRow`) and the focused-pane sequenced stepper
// (`Stepper`). It renders a row of status-colored, icon-bearing nodes joined by connectors.
//
// The visual language is the blueprint card's (the look we standardized on, #1869): a 24px
// rounded-SQUARE node showing the stage's icon (✓ once done), status-colored — complete = filled
// success, ahead = success-ringed (banked out of sequence), active = accent-ringed (pulses only in
// the interactive stepper), skipped = info-tinted, locked/upcoming = dim. Pure presentational:
// callers map their own model (blueprint sections via `stageStatus`, or focused-plan `Stage`s) into
// `RailNode[]` and pass it in. CSS in progressionRail.css (imported here so every consumer gets it).

import { Fragment, type ReactNode } from "react";
import { Ic } from "../blueprints/blueprintIcons";
import type { ConnectorKind } from "../stages/focusedPlan";
import "./progressionRail.css";

/** The unified node state. The focused-pane `StageStatus` IS this set; the blueprint card maps its
 *  narrower `stageStatus` ("in-progress" → "active") into it. */
export type RailStatus = "complete" | "ahead" | "active" | "skipped" | "locked" | "upcoming";

export interface RailNode {
  key: string;
  status: RailStatus;
  /** Icon glyph NAME (resolved by the caller through the stage→icon map, `stageKind`) — rendered as
   *  inline SVG via {@link Ic}. A done node (complete/ahead) shows ✓ instead. */
  icon: string;
  /** Hover tooltip for the node. */
  title?: string;
  /** Label rendered beneath the node — shown in the `stepper` variant only. */
  label?: string;
}

/** A done node shows the ✓; any other state shows its stage icon (the card look — the ring color,
 *  not a distinct glyph, carries active/skipped/locked/upcoming). */
function nodeContent(n: RailNode): ReactNode {
  return n.status === "complete" || n.status === "ahead" ? "✓" : <Ic n={n.icon} size={13} />;
}

/** The card's 2-state connector: the segment AFTER a completed node is solid (success), else dim.
 *  The stepper passes its own richer `connectorKind` (solid/partial/dashed/dim, #668). */
function defaultConnector(nodes: RailNode[], i: number): ConnectorKind {
  return nodes[i].status === "complete" ? "solid" : "dim";
}

/**
 * @param nodes        the rail's nodes, in order
 * @param variant      "compact" = inline card preview (no labels, static); "stepper" = labeled,
 *                     interactive, the active node pulses
 * @param selectedIdx  the highlighted (selected) node — stepper navigation
 * @param onSelect     click handler; when omitted the rail is non-interactive (card preview)
 * @param highlight    node keys to flag for attention (they pulse red) — e.g. incomplete phases
 * @param connectorKind  per-gap connector style; defaults to the card's complete→solid/else→dim
 */
export function ProgressionRail({
  nodes,
  variant = "compact",
  selectedIdx,
  onSelect,
  highlight,
  connectorKind,
}: {
  nodes: RailNode[];
  variant?: "compact" | "stepper";
  selectedIdx?: number;
  onSelect?: (i: number) => void;
  highlight?: Set<string>;
  connectorKind?: (nodes: RailNode[], i: number) => ConnectorKind;
}) {
  if (nodes.length === 0) return null;
  const conn = connectorKind ?? defaultConnector;
  const rail = (
    <div className={`prail ${variant}`}>
      {nodes.map((n, i) => {
        const segClass =
          `prail-seg ${n.status}` +
          (i === selectedIdx ? " sel" : "") +
          (highlight?.has(n.key) ? " attn" : "");
        const inner = (
          <>
            <span className={`prail-node ${n.status}`}>{nodeContent(n)}</span>
            {variant === "stepper" && <span className="prail-label">{n.label}</span>}
          </>
        );
        return (
          <Fragment key={n.key}>
            {onSelect ? (
              <button type="button" className={segClass} title={n.title ?? n.label} onClick={() => onSelect(i)}>
                {inner}
              </button>
            ) : (
              <span className={segClass} title={n.title}>
                {inner}
              </span>
            )}
            {i < nodes.length - 1 && <span className={"prail-conn " + conn(nodes, i)} />}
          </Fragment>
        );
      })}
    </div>
  );
  // The stepper sits in a bordered strip below the pane header; the compact card preview is bare.
  return variant === "stepper" ? <div className="prail-wrap">{rail}</div> : rail;
}
